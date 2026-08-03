/**
 * F128 Cat-side propose-thread callback route.
 *
 * POST /api/callbacks/propose-thread
 *   Cat-auth. Creates a Proposal (status=pending); does NOT create a thread.
 *   Idempotent via clientRequestId.
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * proposal-routes.ts.
 */

import type { ApprovalEnvelope, CatId, ThreadProposal } from '@cat-cafe/shared';
import { catIdSchema, generateProposalId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { migrateStoredProjectPath, resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { buildProposalCardBlock } from './proposal-card-block.js';
import { prepareCommunityPrProposalMessage } from './proposal-community-pr-gate.js';

const proposeThreadCallbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  preferredCats: z.array(catIdSchema()).max(10).optional(),
  initialMessage: z.string().max(4000).optional(),
  // F128 Phase AA (AC-AA1): reporting contract. Omitted → default final-only (supersedes Phase Y AC-Y6 none).
  reportingMode: z.enum(['none', 'final-only', 'state-transitions', 'blocking-ack']).optional(),
  // F128: explicit project ownership for the child thread. Validated against allowed roots
  // (resolvePersistentProjectPath) — NOT hardcoded. Omitted → inherit source thread's projectPath;
  // supplied-but-invalid → 400 (fail loud, never silently fall back to default).
  projectPath: z.string().min(1).max(500).optional(),
  parentThreadId: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface ProposeThreadDeps {
  registry: InvocationRegistry;
  proposalStore: IProposalStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  approvalIngress?: ApprovalIngress;
}

export function registerCallbackProposeThreadRoutes(app: FastifyInstance, deps: ProposeThreadDeps): void {
  const { registry, proposalStore, threadStore, messageStore, socketManager } = deps;
  const approvalIngress = deps.approvalIngress ?? new ApprovalIngress({ messageStore, socketManager });

  app.post('/api/callbacks/propose-thread', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeThreadCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const {
      title,
      reason,
      preferredCats,
      initialMessage: rawInitialMessage,
      reportingMode,
      projectPath: explicitProjectPath,
      parentThreadId,
      clientRequestId,
    } = parsed.data;
    const invocationId = record.invocationId;

    // F128: cats sometimes paste raw catIds (`@cat-rcs85pvn`) from
    // `cat_cafe_get_thread_cats` output into `initialMessage` instead of the
    // stable handle (`@砚砚` / `@opus46`). Raw catIds aren't in the router's
    // mentionPatterns, so downstream `router.parseAllMentions` won't see them
    // as mentions — dispatch then walks `preferredCats` in the wrong order.
    // Normalize at the propose boundary so the persisted card text matches
    // how the cat would have written @mentions in the same thread.
    const preparedMessage = prepareCommunityPrProposalMessage({
      title,
      reason,
      ...(rawInitialMessage ? { initialMessage: rawInitialMessage } : {}),
    });
    if ('error' in preparedMessage) {
      reply.status(400);
      return preparedMessage;
    }
    const { initialMessage, communityPrContext } = preparedMessage;

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    // The approval origin is the exact message that caused this invocation. Direct user
    // turns intentionally have no a2aTriggerMessageId (that field controls reply threading),
    // so use the dedicated turn origin and keep the A2A field as a legacy-record fallback.
    const originMessageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
    if (!originMessageId) {
      reply.status(400);
      return { error: 'Exact source message is required for an approval proposal' };
    }

    // Idempotency fast path: only return success if the proposal is fully VISIBLE — i.e. the
    // rich card has been appended (cardMessageId set). For proposals where cardMessageId is
    // missing, try a best-effort self-heal: scan the source thread for a card whose rich block
    // id matches this proposalId, and backfill the marker. This recovers from the "card written,
    // marker write failed" partial commit.
    if (clientRequestId) {
      const cached = await proposalStore.getDedupProposalId(record.userId, clientRequestId);
      if (cached) {
        const proposal = await proposalStore.get(cached);
        if (proposal) {
          const legacyResponse = await visibleLegacyProposalResponse(approvalIngress, proposalStore, proposal);
          if (legacyResponse) return legacyResponse;
          if (!proposal.publication) {
            reply.status(503);
            reply.header('retry-after', '1');
            return { error: 'Legacy proposal card is not visible; retry shortly', status: 'retryable' };
          }
          const envelope = await publishThreadApproval(approvalIngress, proposalStore, proposal);
          return {
            proposalId: proposal.proposalId,
            status: proposal.status,
            messageId: envelope.approvalCardRef.messageId,
            deduped: true,
          };
        }
        // Cached but proposal missing — winner crashed before persisting; let the
        // SET-NX path below reclaim the dedup key.
      }
    }

    // Resolve parent thread: explicit value (with ownership check) or source-thread fallback.
    const sourceThread = await threadStore.get(record.threadId);
    if (!sourceThread) {
      reply.status(404);
      return { error: 'Source thread not found' };
    }

    // The effective parent defaults to the source thread, but an explicit parentThreadId
    // re-roots the child — and projectPath must inherit from the EFFECTIVE parent, not the
    // source (spec: "projectPath 默认继承 parent thread"). Track the resolved parent thread so
    // a re-parent doesn't silently keep the source thread's ownership.
    let resolvedParentThreadId = record.threadId;
    let parentThread = sourceThread;
    if (parentThreadId && parentThreadId !== record.threadId) {
      const parent = await threadStore.get(parentThreadId);
      if (!parent || parent.createdBy !== record.userId) {
        reply.status(403);
        return { error: 'parentThreadId does not belong to the current user' };
      }
      resolvedParentThreadId = parentThreadId;
      parentThread = parent;
    }

    // F128: resolve the child thread's project ownership (the cwd/runtime-sanctuary bug's
    // root cause was child threads inheriting a `default` projectPath). Fail loud on an
    // invalid explicit path — never silently fall back to source/default, or a cat that
    // thinks it pinned `clowder-ai` would land in `default` (砚砚 review push-back #1).
    let resolvedProjectPath = parentThread.projectPath; // omitted → inherit effective parent thread
    if (explicitProjectPath !== undefined) {
      const validatedProjectPath = await resolvePersistentProjectPath(explicitProjectPath);
      if (!validatedProjectPath) {
        reply.status(400);
        return { error: 'Invalid projectPath: must be an existing directory under allowed roots' };
      }
      resolvedProjectPath = validatedProjectPath; // supplied & valid → canonical real path
    } else if (resolvedProjectPath && resolvedProjectPath !== 'default') {
      const inheritedProjectPath = await migrateStoredProjectPath(resolvedProjectPath);
      if (!inheritedProjectPath) {
        reply.status(400);
        return { error: 'Inherited projectPath no longer resolves to a persistent workspace' };
      }
      resolvedProjectPath = inheritedProjectPath;
    }

    // P2: Reserve dedup BEFORE create. Pre-generate a candidate proposalId, then atomically
    // SET NX. The loser of a concurrent retry must NOT create anything (otherwise the pending
    // list grows by N for N concurrent retries even though they share one clientRequestId).
    let proposalId: string;
    let reservedDedup = false;
    if (clientRequestId) {
      const candidate = generateProposalId();
      const winningId = await proposalStore.reserveDedup(record.userId, clientRequestId, candidate);
      if (winningId !== candidate) {
        // Loser path. Return deduped success ONLY if the winner's proposal is FULLY VISIBLE
        // (cardMessageId set). If marker is missing, try the same source-thread self-heal as
        // the fast path before reporting in-flight.
        const canonical = await proposalStore.get(winningId);
        if (!canonical) {
          reply.status(503);
          reply.header('retry-after', '1');
          return {
            error: 'Proposal reservation in-flight by a concurrent request; retry shortly',
            status: 'retryable',
          };
        }
        const legacyResponse = await visibleLegacyProposalResponse(approvalIngress, proposalStore, canonical);
        if (legacyResponse) return legacyResponse;
        if (!canonical.publication) {
          reply.status(503);
          reply.header('retry-after', '1');
          return { error: 'Legacy proposal card is not visible; retry shortly', status: 'retryable' };
        }
        const envelope = await publishThreadApproval(approvalIngress, proposalStore, canonical);
        return {
          proposalId: winningId,
          status: canonical.status,
          messageId: envelope.approvalCardRef.messageId,
          deduped: true,
        };
      }
      proposalId = candidate;
      reservedDedup = true;
    } else {
      proposalId = generateProposalId();
    }

    let proposal: ThreadProposal;
    try {
      proposal = await proposalStore.create({
        proposalId,
        sourceThreadId: record.threadId,
        sourceInvocationId: invocationId,
        sourceCatId: record.catId,
        sourceMessageId: originMessageId,
        title,
        reason,
        parentThreadId: resolvedParentThreadId,
        preferredCats: (preferredCats ?? []) as CatId[],
        projectPath: resolvedProjectPath,
        createdBy: record.userId,
        ...(initialMessage ? { initialMessage } : {}),
        ...(reportingMode ? { reportingMode } : {}),
        ...(communityPrContext ? { communityPrContext } : {}),
      });
    } catch (err) {
      // Critical: if we reserved a dedup key but failed to create the proposal it points at,
      // release the reservation so the caller's retry can claim it. Without this, the key stays
      // a phantom pointer for the dedup TTL window.
      if (reservedDedup && clientRequestId) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposalId);
        } catch {
          // best-effort cleanup; surface the original error
        }
      }
      throw err;
    }

    let envelope: ApprovalEnvelope;
    try {
      envelope = await publishThreadApproval(approvalIngress, proposalStore, proposal);
    } catch (err) {
      if (reservedDedup && clientRequestId && !(await proposalStore.get(proposal.proposalId))) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposal.proposalId);
        } catch {
          // best-effort cleanup
        }
      }
      throw err;
    }

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: envelope.approvalCardRef.messageId,
    };
  });
}

async function visibleLegacyProposalResponse(
  ingress: ApprovalIngress,
  store: IProposalStore,
  proposal: ThreadProposal,
) {
  if (proposal.publication) return null;
  const cardMessageId =
    proposal.cardMessageId ??
    (await ingress.recoverLegacyCard({
      producerId: 'F128',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      cardThreadId: proposal.sourceThreadId,
      cardBlockId: buildProposalCardBlock(proposal).id,
    }));
  if (!cardMessageId) return null;
  if (!proposal.cardMessageId) await store.setCardMessageId(proposal.proposalId, cardMessageId);
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    messageId: cardMessageId,
    deduped: true as const,
  };
}

function publishThreadApproval(ingress: ApprovalIngress, store: IProposalStore, proposal: ThreadProposal) {
  if (!proposal.sourceMessageId) throw new Error('F128 Phase-I proposal is missing its persisted source message');
  return ingress.publish(
    {
      producerId: 'F128',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      originRef: { kind: 'message', threadId: proposal.sourceThreadId, messageId: proposal.sourceMessageId },
      cardThreadId: proposal.sourceThreadId,
      cardContent: `提议新建 thread：${proposal.title}`,
      cardBlock: buildProposalCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}
