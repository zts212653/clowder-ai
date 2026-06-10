/**
 * F225 Task B1: Cat-initiated session handoff approve transaction (commit-point model).
 *
 * Spec「Approve 事务顺序」(KD-8/9):
 *   Pre-commit  (claim → 校验 active → 持久化 note) 可 fail/expire
 *   Commit point = requestSeal accepted (不可逆: session 置 sealing + 清 active pointer)
 *   Post-commit (enqueue continuation → finalize) 只 recover-forward
 *
 * 写成纯事务函数（依赖注入）便于单元测试 commit-point/失败边界，route 是薄 wire。
 * Post-commit 失败（enqueue/finalize throw）由 caller 上抛 → crash recovery (B3) 按
 * checkpoint 续跑，本函数 commit point 后绝不 rollback（否则留半封印孤儿）。
 */

import type { CatHandoffNote, CatId, SessionHandoffProposal } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { ISessionHandoffProposalStore } from '../stores/ports/SessionHandoffProposalStore.js';

export interface SessionHandoffApproveDeps {
  handoffProposalStore: ISessionHandoffProposalStore;
  sessionChainStore: Pick<ISessionChainStore, 'get' | 'getActive' | 'update'>;
  /** Wire to sessionSealer.requestSeal({sessionId, reason}) → { accepted }. */
  requestSeal: (sessionId: string, reason: string) => Promise<{ accepted: boolean }>;
  /** Wire to invocationQueue.enqueue + processNext; idempotency keyed by proposalId. */
  enqueueContinuation: (input: ContinuationInput) => Promise<{ entryId: string }>;
  now?: () => number;
}

export interface ContinuationInput {
  proposalId: string;
  sourceSessionId: string;
  threadId: string;
  catId: CatId;
  note: CatHandoffNote;
}

export type ApproveResult =
  | { ok: true; proposal: SessionHandoffProposal }
  | { ok: false; stage: 'pre-commit'; reason: 'not_pending' | 'session_changed' | 'seal_rejected' };

/**
 * Approve a session-handoff proposal. Returns ok:true with the finalized proposal,
 * or ok:false (pre-commit only) when claim/validation/seal fails — those are safe to
 * expire because no irreversible side effect happened yet. Once requestSeal is accepted
 * (commit point), the only outcomes are success or a thrown error for recovery to resume.
 */
export async function approveSessionHandoff(
  deps: SessionHandoffApproveDeps,
  proposalId: string,
): Promise<ApproveResult> {
  const now = deps.now ?? (() => Date.now());
  const { handoffProposalStore: store, sessionChainStore } = deps;

  // ── Pre-commit step 1: CAS claim ──
  const claimed = await store.claimForApproval(proposalId);
  if (!claimed) return { ok: false, stage: 'pre-commit', reason: 'not_pending' };

  // ── Pre-commit step 2: 校验 sourceSessionId 仍是同 (user,thread,cat) 的 active session ──
  // getActive 返回当前 active；若 sourceSessionId 已被新 session 取代 → 晚 approve，reject (KD-6)。
  const session = await sessionChainStore.get(claimed.sourceSessionId);
  const active = await sessionChainStore.getActive(claimed.sourceCatId, claimed.sourceThreadId);
  const stillActive =
    session?.status === 'active' && active?.id === claimed.sourceSessionId && session.userId === claimed.userId;
  if (!stillActive) {
    await store.markExpired(proposalId);
    return { ok: false, stage: 'pre-commit', reason: 'session_changed' };
  }

  // ── Pre-commit step 3: 持久化 catHandoffNote 到 session（commit-point 反推 key, KD-9） ──
  await sessionChainStore.update(claimed.sourceSessionId, { catHandoffNote: claimed.note });
  await store.recordCheckpoint(proposalId, { handoffNotePersistedAt: now() });

  // ── Commit point: requestSeal ──
  const seal = await deps.requestSeal(claimed.sourceSessionId, 'cat_initiated_handoff');
  if (!seal.accepted) {
    // Still pre-commit (no irreversible seal). Stale note stays on session but B4 injection
    // gating (sealReason='cat_initiated_handoff' + matching proposal) keeps it from leaking.
    await store.markExpired(proposalId);
    return { ok: false, stage: 'pre-commit', reason: 'seal_rejected' };
  }
  // COMMIT POINT crossed — record durable checkpoint; from here only recover-forward.
  await store.recordCheckpoint(proposalId, { sealedSessionId: claimed.sourceSessionId, sealAcceptedAt: now() });

  // ── Post-commit (recover-forward only; throw on failure → recovery resumes from checkpoint) ──
  const cont = await deps.enqueueContinuation({
    proposalId,
    sourceSessionId: claimed.sourceSessionId,
    threadId: claimed.sourceThreadId,
    catId: claimed.sourceCatId,
    note: claimed.note,
  });
  await store.recordCheckpoint(proposalId, { continuationEntryId: cont.entryId });
  const finalized = await store.finalizeApproval(proposalId);
  // finalizeApproval CAS-returns null only if status drifted; treat as already-approved.
  return { ok: true, proposal: finalized ?? (await store.get(proposalId))! };
}

export interface RecoverResult {
  recovered: boolean;
  outcome?: 'completed' | 'expired';
  reason?: 'not_approving' | 'ambiguous_session_state';
}

/**
 * B3: resume a stale 'approving' handoff proposal after a crash (KD-9 crash-window 闭合).
 *
 * The commit point (session-side `requestSeal` → sealing) and the proposal-side checkpoint
 * (sealedSessionId) are two SEPARATE writes; a crash between them leaves an 'approving'
 * proposal with handoffNotePersistedAt but no sealedSessionId. We CANNOT judge pre-commit
 * from the proposal alone — must cross-check the session side: if the session is already
 * sealing/sealed by THIS handoff (sealReason + note.proposalId match), the commit point
 * passed → backfill checkpoint + recover-forward; if still active, seal never happened →
 * safe to expire (砚砚 R3 P1).
 */
export async function recoverStaleHandoffProposal(
  deps: SessionHandoffApproveDeps,
  proposalId: string,
): Promise<RecoverResult> {
  const now = deps.now ?? (() => Date.now());
  const { handoffProposalStore: store, sessionChainStore } = deps;

  let proposal = await store.get(proposalId);
  if (!proposal || proposal.status !== 'approving') {
    return { recovered: false, reason: 'not_approving' };
  }

  // Commit checkpoint missing → reverse-lookup session side. Covers BOTH crash sub-states
  // (砚砚 review P1): "claim → note-checkpoint crash" (no checkpoint at all) AND
  // "note → seal-checkpoint crash" (handoffNotePersistedAt set, sealedSessionId not).
  if (!proposal.sealedSessionId) {
    const session = await sessionChainStore.get(proposal.sourceSessionId);
    const sealedByThisHandoff =
      !!session &&
      (session.status === 'sealing' || session.status === 'sealed') &&
      session.sealReason === 'cat_initiated_handoff' &&
      session.catHandoffNote?.proposalId === proposalId;
    if (sealedByThisHandoff) {
      // commit point actually crossed before the crash → backfill durable checkpoint(s)
      // (handoffNotePersistedAt may also be lost if both writes were dropped).
      proposal = (await store.recordCheckpoint(proposalId, {
        handoffNotePersistedAt: proposal.handoffNotePersistedAt ?? now(),
        sealedSessionId: proposal.sourceSessionId,
        sealAcceptedAt: now(),
      }))!;
    } else {
      // requestSeal never accepted (note never persisted, or persisted but seal not reached) →
      // truly pre-commit. Safe to expire — no half-sealed orphan possible; any stale session
      // note is gated out by B4 (sealReason mismatch). Frees the A4 ≤1-pending slot.
      await store.markExpired(proposalId);
      return { recovered: true, outcome: 'expired' };
    }
  }

  // Post-commit recover-forward (idempotent): recreate/verify the continuation queue entry, then
  // finalize. continuationEntryId is persisted with the proposal, but InvocationQueue itself is
  // process-local; after a process crash the old entry id is only diagnostic. Re-enqueueing is safe
  // because enqueueContinuation is keyed by proposalId and dedupes any still-active entry.
  if (proposal.sealedSessionId && proposal.status === 'approving') {
    const cont = await deps.enqueueContinuation({
      proposalId,
      sourceSessionId: proposal.sourceSessionId,
      threadId: proposal.sourceThreadId,
      catId: proposal.sourceCatId,
      note: proposal.note,
    });
    proposal = (await store.recordCheckpoint(proposalId, { continuationEntryId: cont.entryId }))!;
  }
  if (proposal.sealedSessionId && proposal.status === 'approving') {
    await store.finalizeApproval(proposalId);
  }
  return { recovered: true, outcome: 'completed' };
}
