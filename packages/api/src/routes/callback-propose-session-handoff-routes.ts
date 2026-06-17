/**
 * F225 cat-side session-handoff propose callback route (接线层②a).
 *
 * POST /api/callbacks/propose-session-handoff
 *   Cat-auth. 猫在干净断点提议封印当前 active session。创建 SessionHandoffProposal
 *   (status=pending) + append 确认卡到 source thread。**不 seal**——co-creator gate（approve）
 *   才进封印事务。A4 abuse guard（≤1 pending/active session + per-(cat,thread) cooldown）
 *   在 proposeSessionHandoff 纯函数里；本 route 是薄 wire（解析五件套 + 卡片 + broadcast）。
 *
 * 配套 approve/reject（user-auth + commit-point 事务）在 session-handoff-approve route（②b）。
 */

import type { CatId, SessionHandoffProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  buildHandoffProposalCardBlock,
  proposeSessionHandoff,
} from '../domains/cats/services/session/sessionHandoffPropose.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { ISessionHandoffProposalStore } from '../domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

// 五件套留言（proposalId/sourceSessionId/persistedAt 由 store 填）。done/nextSteps 必填，其余可选。
// clientRequestId：transport-retry 幂等 key（云端 P2，对齐 F128），不进 note。
const proposeHandoffSchema = z.object({
  done: z.string().trim().min(1).max(2000),
  nextSteps: z.string().trim().min(1).max(2000),
  worktreeBranch: z.string().trim().max(200).optional(),
  commits: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  gotchas: z.string().trim().max(2000).optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface ProposeSessionHandoffDeps {
  registry: InvocationRegistry;
  handoffProposalStore: ISessionHandoffProposalStore;
  sessionChainStore: Pick<ISessionChainStore, 'getActive'>;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

const GATE_REASON_MESSAGE: Record<string, string> = {
  no_active_session: '当前没有可封印接力的活跃 session。',
  already_pending: '已有一个待确认的 session 接力提议（每个 active session 最多 1 个）。',
  cooldown: '刚提议过 session 接力，冷却中，请稍后再发起。',
  hourly_limit: '本 thread 最近一小时的 handoff 提议已达上限，请稍后再发起。',
};

/** High enough to cover any realistic thread without paging — self-heal scans the whole thread. */
const SELF_HEAL_SCAN_LIMIT = 10000;

/**
 * Scan the source thread for the confirmation card (rich block id `handoff-${proposalId}`) so a
 * retry can self-heal a proposal whose card WAS appended but whose cardMessageId marker-write failed
 * (partial commit). Best-effort; mirrors F128 findCardMessageInThread (砚砚 re-review P2-B).
 */
async function findHandoffCardMessageId(
  messageStore: IMessageStore,
  threadId: string,
  proposalId: string,
): Promise<string | null> {
  try {
    const messages = await messageStore.getByThread(threadId, SELF_HEAL_SCAN_LIMIT);
    const target = `handoff-${proposalId}`;
    for (const msg of messages) {
      for (const block of msg.extra?.rich?.blocks ?? []) {
        if (block.id === target) return msg.id;
      }
    }
  } catch {
    // self-heal is best-effort; swallow store errors
  }
  return null;
}

type DedupOutcome =
  | { kind: 'hit'; body: { proposalId: string; status: string; messageId: string; deduped: true } }
  | { kind: 'pending' };

const dedupBody = (proposalId: string, status: string, messageId: string) =>
  ({ proposalId, status, messageId, deduped: true }) as const;

/**
 * Resolve a dedup-keyed proposalId to an idempotent response (砚砚 re-review P2-B): a visible card →
 * deduped success; a partial commit (card appended, marker-write failed) → self-heal + deduped
 * success; otherwise the winner is still in-flight (or crashed pre-persist) → 'pending' (caller 503s).
 */
async function resolveDedupOutcome(
  store: ISessionHandoffProposalStore,
  messageStore: IMessageStore,
  proposalId: string,
): Promise<DedupOutcome> {
  const proposal = await store.get(proposalId);
  if (proposal?.cardMessageId) {
    return { kind: 'hit', body: dedupBody(proposal.proposalId, proposal.status, proposal.cardMessageId) };
  }
  if (proposal) {
    const recovered = await findHandoffCardMessageId(messageStore, proposal.sourceThreadId, proposal.proposalId);
    if (recovered) {
      try {
        await store.recordCheckpoint(proposal.proposalId, { cardMessageId: recovered });
      } catch {
        // best-effort backfill so later retries skip the scan; we can still answer this one
      }
      return { kind: 'hit', body: dedupBody(proposal.proposalId, proposal.status, recovered) };
    }
  }
  return { kind: 'pending' };
}

function respond503(reply: FastifyReply): { error: string; status: string } {
  reply.status(503);
  reply.header('retry-after', '1');
  return { error: 'Handoff proposal in-flight (card pending); retry shortly', status: 'retryable' };
}

type ReserveOutcome = { kind: 'respond'; body: unknown } | { kind: 'proceed'; reservedProposalId?: string };

/**
 * Idempotency fast path + reserve (云端 P2 + 砚砚 P2-A/B). Returns 'respond' (a deduped hit or a 503
 * body to send straight back) or 'proceed' with the reserved proposalId the caller must create under.
 */
async function fastPathOrReserve(
  store: ISessionHandoffProposalStore,
  messageStore: IMessageStore,
  userId: string,
  clientRequestId: string | undefined,
  reply: FastifyReply,
): Promise<ReserveOutcome> {
  if (!clientRequestId) return { kind: 'proceed' };
  // Fast path: a known clientRequestId resolves back to the original (visible / self-healed) proposal.
  const cachedId = await store.getDedupProposalId(userId, clientRequestId);
  if (cachedId) {
    const outcome = await resolveDedupOutcome(store, messageStore, cachedId);
    return { kind: 'respond', body: outcome.kind === 'hit' ? outcome.body : respond503(reply) };
  }
  // Reserve BEFORE create (SET NX): the loser of a concurrent retry never creates a 2nd proposal.
  const candidate = generateProposalId();
  const winningId = await store.reserveDedup(userId, clientRequestId, candidate);
  if (winningId !== candidate) {
    const outcome = await resolveDedupOutcome(store, messageStore, winningId);
    return { kind: 'respond', body: outcome.kind === 'hit' ? outcome.body : respond503(reply) };
  }
  return { kind: 'proceed', reservedProposalId: candidate };
}

/**
 * Append the confirmation card (the ONLY user-facing gate entry point), record the cardMessageId
 * marker, and broadcast. On append failure runs onAppendFail (delete phantom + release dedup) then
 * rethrows; marker-write failure degrades to a warning (card is on screen; retries self-heal — P2-B).
 */
async function persistAndBroadcastCard(
  store: ISessionHandoffProposalStore,
  messageStore: IMessageStore,
  socketManager: SocketManager,
  record: { userId: string; catId: CatId; threadId: string },
  proposal: SessionHandoffProposal,
  onAppendFail: () => Promise<void>,
): Promise<{ messageId: string; warnings: string[] }> {
  const cardBlock = buildHandoffProposalCardBlock(proposal);
  let stored: Awaited<ReturnType<IMessageStore['append']>>;
  try {
    stored = await messageStore.append({
      userId: record.userId,
      catId: record.catId,
      content: '提议 session 接力（封印当前 → 续接 fresh 自己）',
      mentions: [],
      timestamp: Date.now(),
      threadId: record.threadId,
      extra: { rich: { v: 1 as const, blocks: [cardBlock] } },
    });
  } catch (err) {
    try {
      await onAppendFail();
    } catch {
      // best-effort cleanup; surface the original error
    }
    throw err;
  }
  const warnings: string[] = [];
  try {
    await store.recordCheckpoint(proposal.proposalId, { cardMessageId: stored.id });
  } catch (err) {
    warnings.push(`recordCheckpoint(cardMessageId) failed: ${err instanceof Error ? err.message : String(err)}`);
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
  return { messageId: stored.id, warnings };
}

/** Release a reserved dedup key, best-effort (no-op when no key was reserved). */
async function releaseDedupQuietly(
  store: ISessionHandoffProposalStore,
  userId: string,
  clientRequestId: string | undefined,
  reservedProposalId: string | undefined,
): Promise<void> {
  if (!clientRequestId || !reservedProposalId) return;
  try {
    await store.releaseDedup(userId, clientRequestId, reservedProposalId);
  } catch {
    // best-effort; Redis TTL self-expires the key, InMemory is process-local
  }
}

/**
 * Run the A4-gated create under the reserved proposalId, releasing the dedup key on either a thrown
 * pre-create failure (P2-A) or an A4 gate reject — neither persists a proposal, so a leaked key would
 * pin every retry to 503 (Redis until TTL; InMemory forever).
 */
async function createReservedProposal(
  store: ISessionHandoffProposalStore,
  sessionChainStore: Pick<ISessionChainStore, 'getActive'>,
  record: { userId: string; catId: CatId; threadId: string },
  note: Omit<z.infer<typeof proposeHandoffSchema>, 'clientRequestId'>,
  clientRequestId: string | undefined,
  reservedProposalId: string | undefined,
): Promise<Awaited<ReturnType<typeof proposeSessionHandoff>>> {
  try {
    const result = await proposeSessionHandoff(
      { handoffProposalStore: store, sessionChainStore },
      {
        sourceCatId: record.catId,
        sourceThreadId: record.threadId,
        userId: record.userId,
        note,
        ...(reservedProposalId ? { proposalId: reservedProposalId } : {}),
      },
    );
    if (!result.ok) await releaseDedupQuietly(store, record.userId, clientRequestId, reservedProposalId);
    return result;
  } catch (err) {
    await releaseDedupQuietly(store, record.userId, clientRequestId, reservedProposalId);
    throw err;
  }
}

export function registerCallbackProposeSessionHandoffRoutes(
  app: FastifyInstance,
  deps: ProposeSessionHandoffDeps,
): void {
  const { registry, handoffProposalStore, sessionChainStore, messageStore, socketManager } = deps;

  app.post('/api/callbacks/propose-session-handoff', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeHandoffSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    // Stale callback guard: a newer invocation for the same thread+cat supersedes (avoid
    // a preempted CLI re-proposing). 200 + stale_ignored so the dying process doesn't retry-storm.
    if (!(await registry.isLatest(record.invocationId))) {
      return { status: 'stale_ignored' };
    }

    const { clientRequestId, ...note } = parsed.data;

    // Idempotency fast path + reserve (云端 P2 + 砚砚 P2-A/B): callbackPost retries the same body on
    // 408/429/5xx. A keyed retry resolves back to the original proposal (visible, or self-healed from
    // a partial commit) instead of tripping the A4 ≤1-pending gate and misreporting "NOT created".
    const dedup = await fastPathOrReserve(handoffProposalStore, messageStore, record.userId, clientRequestId, reply);
    if (dedup.kind === 'respond') return dedup.body;
    const reservedProposalId = dedup.reservedProposalId;

    // Create under the reserved id; the helper releases the dedup key on a thrown pre-create failure
    // (P2-A) or an A4 gate reject so a leaked key never pins retries to 503.
    const result = await createReservedProposal(
      handoffProposalStore,
      sessionChainStore,
      record,
      note,
      clientRequestId,
      reservedProposalId,
    );
    if (!result.ok) {
      // A4 / no-active-session are gate outcomes, not errors — surface 200 + reason so the cat reacts.
      return { status: 'rejected', reason: result.reason, message: GATE_REASON_MESSAGE[result.reason] };
    }

    const proposal = result.proposal;
    const { messageId, warnings } = await persistAndBroadcastCard(
      handoffProposalStore,
      messageStore,
      socketManager,
      record,
      proposal,
      async () => {
        // append failed → don't leave a phantom pinning the A4 ≤1 slot, and free the dedup key.
        await handoffProposalStore.delete(proposal.proposalId);
        await releaseDedupQuietly(handoffProposalStore, record.userId, clientRequestId, reservedProposalId);
      },
    );

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
