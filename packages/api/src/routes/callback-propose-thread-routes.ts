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

import type { CatId, RichCardBlock, ThreadProposal } from '@cat-cafe/shared';
import { catIdSchema, generateProposalId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { normalizeCatIdMentionsInText } from '../utils/cat-mention-handle.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const proposeThreadCallbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  preferredCats: z.array(catIdSchema()).max(10).optional(),
  initialMessage: z.string().max(4000).optional(),
  parentThreadId: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface ProposeThreadDeps {
  registry: InvocationRegistry;
  proposalStore: IProposalStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

export function buildProposalCardBlock(proposal: ThreadProposal): RichCardBlock {
  const fields: Array<{ label: string; value: string }> = [
    { label: '父 Thread', value: proposal.parentThreadId },
    {
      label: '建议成员',
      value: proposal.preferredCats.length > 0 ? proposal.preferredCats.join(', ') : '（未指定）',
    },
  ];
  if (proposal.initialMessage) fields.push({ label: '首条消息', value: proposal.initialMessage });
  return {
    id: `proposal-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: `📥 提议新建 thread：${proposal.title}`,
    bodyMarkdown: proposal.reason,
    tone: 'info',
    fields,
    actions: [
      { label: '批准并创建', action: 'propose:approve', payload: { proposalId: proposal.proposalId } },
      { label: '驳回', action: 'propose:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}

export function registerCallbackProposeThreadRoutes(app: FastifyInstance, deps: ProposeThreadDeps): void {
  const { registry, proposalStore, threadStore, messageStore, socketManager } = deps;

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
    const initialMessage = rawInitialMessage ? normalizeCatIdMentionsInText(rawInitialMessage) : rawInitialMessage;

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
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
        if (proposal && proposal.cardMessageId) {
          return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
        }
        if (proposal && !proposal.cardMessageId) {
          const recoveredId = await findCardMessageInThread(messageStore, proposal.sourceThreadId, proposal.proposalId);
          if (recoveredId) {
            // best-effort backfill so subsequent retries skip the scan
            try {
              await proposalStore.setCardMessageId(proposal.proposalId, recoveredId);
            } catch {
              // ignore; we can still answer this request
            }
            return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
          }
          reply.status(503);
          reply.header('retry-after', '1');
          return {
            error: 'Proposal in-flight (card pending); retry shortly',
            status: 'retryable',
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

    let resolvedParentThreadId = record.threadId;
    if (parentThreadId && parentThreadId !== record.threadId) {
      const parent = await threadStore.get(parentThreadId);
      if (!parent || parent.createdBy !== record.userId) {
        reply.status(403);
        return { error: 'parentThreadId does not belong to the current user' };
      }
      resolvedParentThreadId = parentThreadId;
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
        if (canonical && !canonical.cardMessageId) {
          const recoveredId = await findCardMessageInThread(
            messageStore,
            canonical.sourceThreadId,
            canonical.proposalId,
          );
          if (recoveredId) {
            try {
              await proposalStore.setCardMessageId(canonical.proposalId, recoveredId);
            } catch {
              // ignore
            }
            return { proposalId: winningId, status: canonical.status, deduped: true };
          }
        }
        if (!canonical || !canonical.cardMessageId) {
          reply.status(503);
          reply.header('retry-after', '1');
          return {
            error: canonical
              ? 'Proposal in-flight by a concurrent request (card pending); retry shortly'
              : 'Proposal reservation in-flight by a concurrent request; retry shortly',
            status: 'retryable',
          };
        }
        return {
          proposalId: winningId,
          status: canonical.status,
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
        title,
        reason,
        parentThreadId: resolvedParentThreadId,
        preferredCats: (preferredCats ?? []) as CatId[],
        projectPath: sourceThread.projectPath,
        createdBy: record.userId,
        ...(initialMessage ? { initialMessage } : {}),
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

    // Render the proposal as a card in the source thread so the user sees + acts on it.
    // The card is the ONLY user-facing approval entry point (no pending dashboard fallback),
    // so if appending it fails we must NOT leave a phantom proposal — delete it and release
    // the dedup so retries can re-create a visible card.
    const cardBlock = buildProposalCardBlock(proposal);
    let stored;
    try {
      stored = await messageStore.append({
        userId: record.userId,
        catId: record.catId,
        content: `提议新建 thread：${title}`,
        mentions: [],
        timestamp: Date.now(),
        threadId: record.threadId,
        extra: { rich: { v: 1 as const, blocks: [cardBlock] } },
      });
    } catch (err) {
      try {
        await proposalStore.delete(proposal.proposalId);
      } catch {
        // best-effort cleanup
      }
      if (reservedDedup && clientRequestId) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposal.proposalId);
        } catch {
          // best-effort cleanup
        }
      }
      throw err;
    }

    // Card is now persisted — mark the proposal as visible so the dedup fast path can return
    // it as a successful prior result on retries. Marker write failures are degraded to a
    // warning rather than rolling back (the card is already on the user's screen). Subsequent
    // retries can self-heal via fast-path source-thread scan + backfill.
    const warnings: string[] = [];
    try {
      await proposalStore.setCardMessageId(proposal.proposalId, stored.id);
    } catch (err) {
      warnings.push(`setCardMessageId failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'connector_message', {
      threadId: record.threadId,
      message: {
        id: stored.id,
        type: 'cat',
        catId: record.catId,
        content: stored.content,
        timestamp: stored.timestamp,
        extra: stored.extra,
      },
    });
    socketManager.emitToUser(record.userId, 'proposal_created', proposal);

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: stored.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/**
 * Best-effort recovery: scan a source thread for the rich card belonging to proposalId.
 * The card's first rich block uses id `proposal-{proposalId}` (see buildProposalCardBlock),
 * which makes the lookup deterministic without adding a new store index.
 *
 * Limit choice: messageStore.getByThread defaults to a small page (~50). For a self-heal
 * scan we need a much wider window so old proposals whose marker write failed long ago can
 * still recover after the thread accumulated more activity. SELF_HEAL_SCAN_LIMIT is set high
 * enough to cover practically any thread (well above realistic chat lengths) without paging.
 */
const SELF_HEAL_SCAN_LIMIT = 10000;

async function findCardMessageInThread(
  messageStore: IMessageStore,
  threadId: string,
  proposalId: string,
): Promise<string | null> {
  try {
    const messages = await messageStore.getByThread(threadId, SELF_HEAL_SCAN_LIMIT);
    const target = `proposal-${proposalId}`;
    for (const msg of messages) {
      const blocks = msg.extra?.rich?.blocks ?? [];
      for (const block of blocks) {
        if (block.id === target) return msg.id;
      }
    }
  } catch {
    // self-heal is best-effort; swallow store errors
  }
  return null;
}
