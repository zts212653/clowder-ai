/**
 * F225 ②b user-side session-handoff approve/reject route (commit-point dispatcher).
 *
 * POST /api/session-handoff/:proposalId/approve — user-auth gate → commit-point 事务
 *   (claim → 校验 active → 持久化 note → requestSeal → enqueue continuation → finalize)；
 *   stale 'approving'（crash 中断）→ recoverStaleHandoffProposal 续跑（idempotent）。
 * POST /api/session-handoff/:proposalId/reject  — user-auth gate → markRejected（**不 seal**）。
 *
 * 不混入 proposal-routes.ts（建-thread 专用，KD-5）。commit-point 事务在 approveSessionHandoff /
 * recoverStaleHandoffProposal 纯函数（KD-8/9）；本 route 只 wire user-auth + requestSeal（适配
 * SessionSealer 对象签名）+ enqueueContinuation（InvocationQueue continuation，idempotency by
 * proposalId, ④ B5）+ processNext kick（KD-6）。
 */

import type { SealReason, SessionHandoffProposal } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { SessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import {
  approveSessionHandoff,
  recoverStaleHandoffProposal,
  type SessionHandoffApproveDeps,
} from '../domains/cats/services/session/sessionHandoffApprove.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { ISessionHandoffProposalStore } from '../domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface SessionHandoffApproveRoutesOptions {
  handoffProposalStore: ISessionHandoffProposalStore;
  sessionChainStore: Pick<ISessionChainStore, 'get' | 'getActive' | 'update'>;
  sessionSealer: Pick<SessionSealer, 'requestSeal' | 'finalize'>;
  invocationQueue: Pick<InvocationQueue, 'enqueue'>;
  queueProcessor?: Pick<QueueProcessor, 'processNext'>;
  socketManager: SocketManager;
  /**
   * How long a proposal may sit in 'approving' before a new approve treats it as crash-stale and
   * recovers it (vs a live in-flight approve, which gets an idempotent in-progress reply). Default
   * 30s — a healthy commit-point transaction finishes in seconds (云端 review P1).
   */
  approveStaleMs?: number;
  /** F192: Record proposal rejection as task outcome A2 signal. */
  onProposalReject?: (input: { proposalId: string; catId: string; threadId: string; rejectionReason?: string }) => void;
}

const paramsSchema = z.object({ proposalId: z.string().min(1).max(200) });

const HANDOFF_CONTINUATION_PROMPT =
  '〔session 接力续接〕你在上个 session 的干净断点主动发起了 handoff 并获批。这是 fresh context 的你——' +
  '上个 session 你亲手写的五件套交接留言已在上方 bootstrap 注入。请据此无缝接力，从 next_steps 继续。';

type OwnedProposal =
  | { ok: true; userId: string; proposal: SessionHandoffProposal }
  | { ok: false; status: number; body: { error: string } };

/** Shared param-parse + user-auth + ownership check for approve/reject (keeps each handler simple). */
async function resolveOwnedProposal(
  request: FastifyRequest,
  store: Pick<ISessionHandoffProposalStore, 'get'>,
): Promise<OwnedProposal> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) return { ok: false, status: 400, body: { error: 'Invalid proposalId' } };
  const userId = resolveUserId(request);
  if (!userId) {
    return { ok: false, status: 401, body: { error: 'Identity required (X-Cat-Cafe-User header or userId query)' } };
  }
  const proposal = await store.get(params.data.proposalId);
  if (!proposal) return { ok: false, status: 404, body: { error: 'Proposal not found' } };
  if (proposal.userId !== userId) {
    return { ok: false, status: 403, body: { error: 'Proposal does not belong to the current user' } };
  }
  return { ok: true, userId, proposal };
}

export const sessionHandoffApproveRoutes: FastifyPluginAsync<SessionHandoffApproveRoutesOptions> = async (
  app,
  opts,
) => {
  const {
    handoffProposalStore,
    sessionChainStore,
    sessionSealer,
    invocationQueue,
    queueProcessor,
    socketManager,
    onProposalReject,
  } = opts;
  const approveStaleMs = opts.approveStaleMs ?? 30_000;

  // Shared deps for approveSessionHandoff + recoverStaleHandoffProposal. userId captured from the
  // request (= proposal.userId after ownership check) so the queued continuation lands in the same
  // per-(thread,user) scope; requestSeal/enqueueContinuation are infra adapters.
  function buildTxnDeps(userId: string): SessionHandoffApproveDeps {
    return {
      handoffProposalStore,
      sessionChainStore,
      requestSeal: async (sessionId, reason) => {
        const r = await sessionSealer.requestSeal({ sessionId, reason: reason as SealReason });
        return { accepted: r.accepted };
      },
      enqueueContinuation: async (input) => {
        const enq = invocationQueue.enqueue({
          threadId: input.threadId,
          userId,
          content: HANDOFF_CONTINUATION_PROMPT,
          source: 'agent',
          sourceCategory: 'continuation',
          targetCats: [input.catId],
          intent: 'session_handoff_continuation',
          idempotencyKey: input.proposalId, // ④ B5: replay → dedupe to the same continuation entry
          continuationKey: input.sourceSessionId,
          autoExecute: true,
          priority: 'urgent',
        });
        if (enq.outcome !== 'enqueued' || !enq.entry) {
          throw new Error(`continuation enqueue failed: outcome=${enq.outcome}`);
        }
        return { entryId: enq.entry.id };
      },
    };
  }

  // pending → full commit-point transaction.
  async function approveAndRespond(
    deps: SessionHandoffApproveDeps,
    proposalId: string,
    userId: string,
    reply: FastifyReply,
  ) {
    const result = await approveSessionHandoff(deps, proposalId);
    if (!result.ok) {
      // pre-commit gate failure (not_pending / session_changed / seal_rejected) → no seal happened.
      // session_changed / seal_rejected already markExpired'd the proposal; emit so an already-mounted
      // card learns the settled state instead of sitting at `pending` until reload (gpt52 GPT-5.4 P2).
      const settled = await handoffProposalStore.get(proposalId);
      if (settled) socketManager.emitToUser(userId, 'proposal_updated', settled);
      reply.status(409);
      return {
        error: 'Handoff approve failed before commit point',
        stage: result.stage,
        reason: result.reason,
        ...(settled ? { status: settled.status } : {}),
      };
    }
    // Commit point crossed → finalize the sealed session. requestSeal only set active→sealing;
    // finalize writes transcript/digest + marks sealed. Without it the stuck reaper would later
    // finalize and overwrite sealReason to global_reaper, destroying cat_initiated_handoff (砚砚 P1-1).
    await finalizeSeal(sessionSealer, result.proposal.sealedSessionId);
    await kickQueue(queueProcessor, result.proposal.sourceThreadId, userId);
    socketManager.emitToUser(userId, 'proposal_updated', result.proposal);
    return {
      proposalId: result.proposal.proposalId,
      status: result.proposal.status,
      sealedSessionId: result.proposal.sealedSessionId,
      continuationEntryId: result.proposal.continuationEntryId,
    };
  }

  // approving (a prior approve crashed mid-transaction) → recover-forward, idempotent.
  async function recoverAndRespond(
    deps: SessionHandoffApproveDeps,
    proposalId: string,
    userId: string,
    reply: FastifyReply,
  ) {
    const rec = await recoverStaleHandoffProposal(deps, proposalId);
    const settled = await handoffProposalStore.get(proposalId);
    if (rec.outcome === 'expired') {
      reply.status(409);
      return { error: 'Handoff expired during recovery (commit point never reached)', status: 'expired' };
    }
    // Recovery also crossed the commit point (sealedSessionId backfilled) → finalize the session
    // to preserve cat_initiated_handoff before the reaper can claim it (砚砚 P1-1).
    await finalizeSeal(sessionSealer, settled?.sealedSessionId);
    await kickQueue(queueProcessor, settled?.sourceThreadId, userId);
    if (settled) socketManager.emitToUser(userId, 'proposal_updated', settled);
    return {
      proposalId,
      status: settled?.status ?? 'approved',
      sealedSessionId: settled?.sealedSessionId,
      continuationEntryId: settled?.continuationEntryId,
      recovered: true,
    };
  }

  // 'approving' is ambiguous — a LIVE in-flight approve (claim→seal mid-transaction) or a crash-stale
  // one. Recovering a live txn would markExpired it mid-flight while the original keeps sealing →
  // orphan (云端 review P1). Recent updatedAt = live → idempotent in-progress; past the stale threshold
  // → recover (a healthy commit-point txn finishes in seconds; updatedAt advances per checkpoint).
  function respondToApproving(
    deps: SessionHandoffApproveDeps,
    proposal: SessionHandoffProposal,
    userId: string,
    reply: FastifyReply,
  ) {
    if (Date.now() - proposal.updatedAt < approveStaleMs) {
      reply.status(409);
      return { error: 'Approve already in progress for this proposal', status: 'approving', retryable: true };
    }
    return recoverAndRespond(deps, proposal.proposalId, userId, reply);
  }

  app.post('/api/session-handoff/:proposalId/approve', async (request, reply) => {
    const auth = await resolveOwnedProposal(request, handoffProposalStore);
    if (!auth.ok) {
      reply.status(auth.status);
      return auth.body;
    }
    const { userId, proposal } = auth;
    const deps = buildTxnDeps(userId);

    switch (proposal.status) {
      case 'rejected':
      case 'expired':
        reply.status(409);
        return { error: `Proposal already ${proposal.status}`, status: proposal.status };
      case 'approved':
        return {
          proposalId: proposal.proposalId,
          status: proposal.status,
          sealedSessionId: proposal.sealedSessionId,
          deduped: true,
        };
      case 'approving':
        return respondToApproving(deps, proposal, userId, reply);
      default:
        return approveAndRespond(deps, proposal.proposalId, userId, reply);
    }
  });

  // F225 云端 review P2: persisted handoff cards mount as 'pending'; mirror ProposalCard by exposing
  // durable status so a reloaded / multi-tab card (that missed the socket event) doesn't re-render
  // live approve/reject buttons on an already-settled proposal.
  app.get('/api/session-handoff/:proposalId', async (request, reply) => {
    const auth = await resolveOwnedProposal(request, handoffProposalStore);
    if (!auth.ok) {
      reply.status(auth.status);
      return auth.body;
    }
    const { proposal } = auth;
    return {
      proposal: {
        proposalId: proposal.proposalId,
        status: proposal.status,
        sealedSessionId: proposal.sealedSessionId,
      },
    };
  });

  app.post('/api/session-handoff/:proposalId/reject', async (request, reply) => {
    const auth = await resolveOwnedProposal(request, handoffProposalStore);
    if (!auth.ok) {
      reply.status(auth.status);
      return auth.body;
    }
    const { userId, proposal } = auth;

    if (proposal.status === 'approved') {
      reply.status(409);
      return { error: 'Proposal already approved (commit point passed)', status: proposal.status };
    }
    if (proposal.status === 'rejected' || proposal.status === 'expired') {
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }

    // CAS pending→rejected. null if status drifted to 'approving' (approve in flight / crashed
    // mid-transaction) — reject must NOT race a possibly-committed seal.
    const marked = await handoffProposalStore.markRejected(proposal.proposalId);
    if (!marked) {
      reply.status(409);
      return { error: 'Proposal is being approved — cannot reject; retry once it settles' };
    }
    socketManager.emitToUser(userId, 'proposal_updated', marked);

    // F192: Record session handoff rejection as task outcome eval signal
    if (onProposalReject) {
      try {
        onProposalReject({
          proposalId: proposal.proposalId,
          catId: proposal.sourceCatId,
          threadId: proposal.sourceThreadId,
        });
      } catch {
        // Best-effort: don't fail the rejection response if signal recording fails
      }
    }

    return { proposalId: marked.proposalId, status: marked.status };
  });
};

async function kickQueue(
  queueProcessor: Pick<QueueProcessor, 'processNext'> | undefined,
  threadId: string | undefined,
  userId: string,
): Promise<void> {
  if (!queueProcessor || !threadId) return;
  try {
    // best-effort: the continuation is queued + autoExecute, so a later tick still picks it up.
    await queueProcessor.processNext(threadId, userId);
  } catch {
    // swallow — kicking is an optimization, not a correctness requirement.
  }
}

async function finalizeSeal(sealer: Pick<SessionSealer, 'finalize'>, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    // best-effort, mirrors invoke-single-cat's requestSeal+finalize pairing. Failure leaves the
    // session 'sealing' for the reaper to backstop; we try here to keep the cat_initiated_handoff reason.
    await sealer.finalize({ sessionId });
  } catch {
    // swallow — reaper is the backstop.
  }
}
