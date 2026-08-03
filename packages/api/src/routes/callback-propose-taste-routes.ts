/**
 * F221 Phase B: cat-side propose-taste callback route.
 *
 * POST /api/callbacks/propose-taste
 *   Cat-auth. Creates a TasteProposal (status=pending) for operator review in
 *   the F246 Approval Hub. Idempotent via clientRequestId. No file writes
 *   at propose time — writing happens only on approve (Task 7).
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * taste-proposal-decision-routes.ts.
 */

import { type ApprovalOriginRef, type CatId, generateProposalId, type TasteProposal } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import { publishTasteProposal } from './wave2-proposal-publication.js';

const TASTE_DIMENSIONS = [
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
] as const;

const proposeSchema = z.object({
  scene: z.string().min(1).max(2000),
  quote: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(50)).min(1).max(10),
  dimension: z.enum(TASTE_DIMENSIONS),
  privacy: z.enum(['public', 'sensitive']),
  sourceMessageId: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(200),
});

export interface ProposeTasteDeps {
  registry: InvocationRegistry;
  tasteProposalStore: ITasteProposalStore;
  socketManager: SocketManager;
  messageStore?: IMessageStore;
  approvalIngress: ApprovalIngress;
}

/**
 * Fastify plugin — must be registered via `app.register()` so the callback auth
 * preHandler hook is scoped to this route.  Plain function registration on the
 * top-level app skips the hook (Fastify encapsulation) → 401 unknown_invocation.
 */
export const callbackProposeTasteRoutes: FastifyPluginAsync<ProposeTasteDeps> = async (app, opts) => {
  const { registry, tasteProposalStore } = opts;

  registerCallbackAuthHook(app, registry);

  app.post('/api/callbacks/propose-taste', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { scene, quote, tags, dimension, privacy, sourceMessageId, clientRequestId } = parsed.data;

    const invocationIsLatest = await registry.isLatest(record.invocationId);

    // Idempotency fast path. A retry identity is required so a persisted card
    // can always recover after an uncertain envelope commit acknowledgement.
    const cached = await tasteProposalStore.getDedupProposalId(record.userId, clientRequestId);
    if (cached) {
      const existing = await tasteProposalStore.get(cached);
      if (existing) {
        // If publication is staged, retry publish() to complete anchoring.
        if (existing.publication?.state === 'staged') {
          if (existing.threadId !== record.threadId) {
            reply.status(409);
            return {
              error: 'Staged proposal recovery must run in its original thread',
              status: 'origin_thread_required',
              sourceThreadId: existing.threadId,
            };
          }
          const originRef =
            existing.approvalOriginRef ?? deriveTasteOriginRef(record, existing.sourceMessageId, existing.threadId);
          await publishTasteProposal(opts.approvalIngress, tasteProposalStore, existing, originRef);
          return { proposalId: existing.id, status: 'pending', recovered: true };
        }
        if (existing.publication?.state === 'anchored') {
          const originRef =
            existing.approvalOriginRef ?? deriveTasteOriginRef(record, existing.sourceMessageId, existing.threadId);
          await publishTasteProposal(opts.approvalIngress, tasteProposalStore, existing, originRef);
        }
        return { proposalId: existing.id, status: existing.status, deduped: true };
      }
    }

    if (!invocationIsLatest) {
      return { status: 'stale_ignored' };
    }

    // Reserve dedup BEFORE create
    const proposalId = generateProposalId();
    const winningId = await tasteProposalStore.reserveDedup(record.userId, clientRequestId, proposalId);
    if (winningId !== proposalId) {
      // Loser path: another request reserved first
      const existing = await tasteProposalStore.get(winningId);
      if (existing) {
        if (existing.publication?.state !== 'anchored') {
          reply.status(503);
          reply.header('retry-after', '1');
          return {
            error: 'Proposal publication is still in-flight; retry shortly',
            status: 'retryable',
          };
        }
        const originRef =
          existing.approvalOriginRef ?? deriveTasteOriginRef(record, existing.sourceMessageId, existing.threadId);
        await publishTasteProposal(opts.approvalIngress, tasteProposalStore, existing, originRef);
        return { proposalId: existing.id, status: existing.status, deduped: true };
      }
      // Winner reserved but hasn't persisted yet → retryable.
      reply.status(503);
      reply.header('retry-after', '1');
      return {
        error: 'Proposal reservation in-flight by a concurrent request; retry shortly',
        status: 'retryable',
      };
    }

    const originRef = deriveTasteOriginRef(record, sourceMessageId, record.threadId);
    let proposal: TasteProposal;
    try {
      proposal = await tasteProposalStore.create({
        proposalId,
        userId: record.userId,
        catId: record.catId,
        threadId: record.threadId,
        sourceMessageId,
        scene,
        quote,
        tags,
        dimension,
        privacy,
        clientRequestId,
        approvalOriginRef: originRef,
      });
    } catch (err) {
      // Release dedup reservation so retries can succeed (matches profile/handoff pattern)
      try {
        await tasteProposalStore.releaseDedup(record.userId, clientRequestId, proposalId);
      } catch {
        // best-effort release — log but don't mask the original error
      }
      throw err;
    }

    // F246 Phase I (AC-I10): ingress owns the card/anchor boundary; the store's
    // abortStaged owns producer-local dedup cleanup for pre-card failures.
    await publishTasteProposal(opts.approvalIngress, tasteProposalStore, proposal, originRef);

    return {
      proposalId: proposal.id,
      status: proposal.status,
    };
  });
};

/**
 * Derive origin ref for taste proposals: prefer explicit sourceMessageId from the cat,
 * then fall back to the invocation trigger message, then event origin.
 */
function deriveTasteOriginRef(
  record: { originTriggerMessageId?: string; a2aTriggerMessageId?: string; invocationId: string; catId: CatId },
  sourceMessageId: string | undefined,
  threadId: string,
): ApprovalOriginRef {
  const messageId = sourceMessageId ?? record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  if (messageId) {
    return { kind: 'message', threadId, messageId };
  }
  return {
    kind: 'event',
    anchor: `invocation:${record.invocationId}`,
    summary: `Taste proposal from ${record.catId}`,
    threadId,
  };
}
