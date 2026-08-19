/**
 * F260 Phase A T1: cat-side propose-entity callback route.
 *
 * POST /api/callbacks/propose-entity
 *   Cat-auth. Creates an EntityProposal (status=pending) for operator approval
 *   via the Approval Hub. Much simpler than F231 profile-update:
 *   - No primer read/hash (no optimistic lock needed)
 *   - No confirmation card (approval happens in Hub directly)
 *   - Required clientRequestId for transport retry recovery. The canonical MCP
 *     producer auto-generates one when the caller omits it.
 *
 * Tool description (per plan): main entry = responding to PR-3 registration
 * nudge one-click call, not spontaneous cat usage.
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * entity-proposal-decision-routes.ts.
 */

import {
  type ApprovalOriginRef,
  type CatId,
  ENTITY_STANCES,
  type EntityProposal,
  type EntityVisibilityScope,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { IEntityProposalStore } from '../domains/approval-hub/stores/ports/IEntityProposalStore.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import { publishEntityProposal } from './wave2-proposal-publication.js';

const ENTITY_TYPES = ['person', 'cat', 'feature', 'concept', 'external'] as const;

const proposeEntitySchema = z.object({
  entityId: z.string().min(1).max(200).describe('Entity ID in type:name format (e.g. "concept:未婚喵")'),
  entityType: z.enum(ENTITY_TYPES).describe('Entity type from registry taxonomy'),
  canonicalName: z.string().min(1).max(200).describe('Human-readable canonical name'),
  aliases: z.array(z.string().min(1).max(200)).min(1).max(20).describe('Aliases to register (at least one required)'),
  stance: z
    .enum(ENTITY_STANCES)
    .describe(
      'Stance on this entity: endorsed (positive), rejected (negative), ' +
        'critique_target (under critique), deliverable_only, or unknown',
    ),
  visibilityScope: z
    .literal('workspace')
    .describe(
      'Visibility scope: only "workspace" is accepted until the resolver supports ' +
        'visibility-aware filtering (KD-7 gate — private entities would leak into ' +
        'global alias/mention output without a read-path visibility check)',
    ),
  provenance: z
    .array(
      z.object({
        source: z.string().min(1).max(200),
        anchor: z.string().min(1).max(500).optional(),
        note: z.string().max(500).optional(),
        date: z.string().max(20).optional(),
      }),
    )
    .min(1)
    .max(10)
    .describe('Provenance chain — at least one entry with source + thread anchor'),
  rationale: z
    .string()
    .min(1)
    .max(1000)
    .describe('Why this entity should be registered — shown to operator in Approval Hub'),
  clientRequestId: z
    .string()
    .min(1)
    .max(200)
    .describe('Required transport retry key — same clientRequestId = idempotent publication recovery'),
});

export interface ProposeEntityDeps {
  registry: InvocationRegistry;
  entityProposalStore: IEntityProposalStore;
  socketManager: SocketManager;
  messageStore?: IMessageStore;
  approvalIngress: ApprovalIngress;
}

/**
 * Fastify plugin — must be registered via `app.register()` so the callback auth
 * preHandler hook is scoped to this route.  Plain function registration on the
 * top-level app skips the hook (Fastify encapsulation) → 401 unknown_invocation.
 */
export const callbackProposeEntityRoutes: FastifyPluginAsync<ProposeEntityDeps> = async (app, opts) => {
  const { registry, entityProposalStore } = opts;

  registerCallbackAuthHook(app, registry);

  app.post('/api/callbacks/propose-entity', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeEntitySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { clientRequestId } = parsed.data;

    // Explicit retry identity avoids both false dedup by business fields and
    // unreachable staged records after a lost commit acknowledgement.
    const cached = await entityProposalStore.getDedupProposalId(record.userId, clientRequestId);
    if (cached) {
      const existing = await entityProposalStore.get(cached);
      if (existing) {
        // Staged = commitEnvelope failed on prior attempt; retry publish().
        if (existing.publication?.state === 'staged') {
          if (existing.sourceThreadId !== record.threadId) {
            reply.status(409);
            return {
              error: 'Staged proposal recovery must run in its original thread',
              status: 'origin_thread_required',
              sourceThreadId: existing.sourceThreadId,
            };
          }
          const originRef = existing.approvalOriginRef ?? deriveEntityOriginRef(record, existing.sourceThreadId);
          await publishEntityProposal(opts.approvalIngress, entityProposalStore, existing, originRef);
          return {
            proposalId: existing.proposalId,
            status: 'pending',
            entityId: existing.entityId,
            recovered: true,
          };
        }
        if (existing.publication?.state === 'anchored') {
          const originRef = existing.approvalOriginRef ?? deriveEntityOriginRef(record, existing.sourceThreadId);
          await publishEntityProposal(opts.approvalIngress, entityProposalStore, existing, originRef);
        }
        return {
          proposalId: existing.proposalId,
          status: existing.status,
          entityId: existing.entityId,
          deduped: true,
        };
      }
    }

    // Reserve dedup BEFORE create (like F221 pattern)
    const proposalId = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const winningId = await entityProposalStore.reserveDedup(record.userId, clientRequestId, proposalId);
    if (winningId !== proposalId) {
      const existing = await entityProposalStore.get(winningId);
      if (existing) {
        if (existing.publication?.state !== 'anchored') {
          reply.status(503);
          reply.header('retry-after', '1');
          return {
            error: 'Proposal publication is still in-flight; retry shortly',
            status: 'retryable',
          };
        }
        const originRef = existing.approvalOriginRef ?? deriveEntityOriginRef(record, existing.sourceThreadId);
        await publishEntityProposal(opts.approvalIngress, entityProposalStore, existing, originRef);
        return {
          proposalId: existing.proposalId,
          status: existing.status,
          entityId: existing.entityId,
          deduped: true,
        };
      }
      reply.status(503);
      reply.header('retry-after', '1');
      return { error: 'Proposal reservation in-flight by a concurrent request; retry shortly', status: 'retryable' };
    }

    const originRef = deriveEntityOriginRef(record, record.threadId);
    let proposal: EntityProposal;
    try {
      proposal = await entityProposalStore.create({
        proposalId,
        entityId: parsed.data.entityId,
        entityType: parsed.data.entityType,
        canonicalName: parsed.data.canonicalName,
        aliases: parsed.data.aliases,
        stance: parsed.data.stance,
        visibilityScope: parsed.data.visibilityScope as EntityVisibilityScope,
        provenance: parsed.data.provenance,
        rationale: parsed.data.rationale,
        sourceThreadId: record.threadId,
        sourceCatId: record.catId,
        ownerUserId: record.userId,
        clientRequestId,
        approvalOriginRef: originRef,
      });
    } catch (err) {
      try {
        await entityProposalStore.releaseDedup(record.userId, clientRequestId, proposalId);
      } catch {
        // best-effort release
      }
      throw err;
    }

    // F246 Phase I (AC-I9): ingress owns the card/anchor boundary; the store's
    // abortStaged owns producer-local dedup cleanup for pre-card failures.
    await publishEntityProposal(opts.approvalIngress, entityProposalStore, proposal, originRef);

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      entityId: proposal.entityId,
    };
  });
};

function deriveEntityOriginRef(
  record: { originTriggerMessageId?: string; a2aTriggerMessageId?: string; invocationId: string; catId: CatId },
  threadId: string,
): ApprovalOriginRef {
  const messageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  if (messageId) {
    return { kind: 'message', threadId, messageId };
  }
  return {
    kind: 'event',
    anchor: `invocation:${record.invocationId}`,
    summary: `Entity proposal from ${record.catId}`,
    threadId,
  };
}
