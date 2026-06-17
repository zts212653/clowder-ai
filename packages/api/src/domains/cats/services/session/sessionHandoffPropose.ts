/**
 * F225 Task A3/A4: cat-side session handoff propose logic + confirmation card.
 *
 * 猫在干净断点调 cat_cafe_propose_session_handoff（MCP tool → callback route）。
 * 逻辑写成纯函数便于单元测试；route 是薄 wire（生成确认卡 + broadcast）。
 * A4 abuse guard: ≤1 pending handoff proposal per active session（co-creator gate 只挡
 * seal，挡不住卡片刷屏，砚砚 P2）。
 */

import type { CatId, RichCardBlock, SessionHandoffProposal } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { ISessionHandoffProposalStore } from '../stores/ports/SessionHandoffProposalStore.js';

export interface ProposeHandoffInput {
  sourceCatId: CatId;
  sourceThreadId: string;
  userId: string;
  /** 五件套留言（proposalId/sourceSessionId/persistedAt 由 store 填） */
  note: {
    done: string;
    nextSteps: string;
    worktreeBranch?: string;
    commits?: string[];
    gotchas?: string;
  };
  proposalId?: string;
}

export interface ProposeHandoffDeps {
  handoffProposalStore: ISessionHandoffProposalStore;
  sessionChainStore: Pick<ISessionChainStore, 'getActive'>;
  /** A4 cooldown window (ms) per (user,cat,thread). Default 5 min. */
  cooldownMs?: number;
  /** A4 hourly cap: max proposals per (user,cat,thread) within hourlyWindowMs. Default 5. */
  hourlyLimit?: number;
  /** A4 hourly window (ms). Default 1h. */
  hourlyWindowMs?: number;
  now?: () => number;
}

export type ProposeResult =
  | { ok: true; proposal: SessionHandoffProposal }
  | { ok: false; reason: 'no_active_session' | 'already_pending' | 'cooldown' | 'hourly_limit' };

/**
 * Create a session-handoff proposal for the cat's CURRENT active session.
 * The session to seal is resolved from getActive (not trusted from the caller) so a cat
 * can only propose handing off the session it is actually running in.
 */
export async function proposeSessionHandoff(
  deps: ProposeHandoffDeps,
  input: ProposeHandoffInput,
): Promise<ProposeResult> {
  const { handoffProposalStore: store, sessionChainStore } = deps;

  const active = await sessionChainStore.getActive(input.sourceCatId, input.sourceThreadId);
  if (!active) return { ok: false, reason: 'no_active_session' };

  // A4: ≤1 pending|approving handoff proposal per active session.
  const existing = await store.listActiveBySession(active.id);
  if (existing.length > 0) return { ok: false, reason: 'already_pending' };

  // A4 cooldown: per (cat,thread) — a reject/expire (or any recent proposal) can't be
  // immediately re-spammed even after the pending slot frees up (砚砚 P2).
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? 5 * 60 * 1000;
  const recent = await store.getMostRecentByCatThread(input.userId, input.sourceCatId, input.sourceThreadId);
  // Elapsed clamped ≥0: the store's monotonic createdAt (P1-3) can sit a few ms ahead of wall-clock
  // now() under same-ms bursts; a just-created proposal has 0 elapsed, never negative.
  if (recent && Math.max(0, now() - recent.createdAt) < cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }

  // A4 hourly cap (砚砚 re-review P2 / AC-A4 / OQ-4): cooldown alone lets ~12 cards/hour slip through
  // at the 5-min default. Cap the proposal count per (user,cat,thread) within the rolling hour window.
  const hourlyWindowMs = deps.hourlyWindowMs ?? 60 * 60 * 1000;
  const hourlyLimit = deps.hourlyLimit ?? 5;
  const recentCount = await store.countRecentByCatThread(
    input.userId,
    input.sourceCatId,
    input.sourceThreadId,
    now() - hourlyWindowMs,
  );
  if (recentCount >= hourlyLimit) {
    return { ok: false, reason: 'hourly_limit' };
  }

  const proposal = await store.create({
    sourceThreadId: input.sourceThreadId,
    sourceSessionId: active.id,
    sourceCatId: input.sourceCatId,
    userId: input.userId,
    note: input.note,
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
  });
  return { ok: true, proposal };
}

/** Confirmation card surfaced to co-creator in the thread (approve/reject gate). */
export function buildHandoffProposalCardBlock(proposal: SessionHandoffProposal): RichCardBlock {
  const n = proposal.note;
  const fields: Array<{ label: string; value: string }> = [
    { label: '封印 session', value: proposal.sourceSessionId },
    { label: '已完成', value: n.done },
    { label: '下一步', value: n.nextSteps },
  ];
  if (n.worktreeBranch) fields.push({ label: 'worktree', value: n.worktreeBranch });
  if (n.commits?.length) fields.push({ label: 'commits', value: n.commits.join(', ') });
  if (n.gotchas) fields.push({ label: 'gotchas', value: n.gotchas });
  return {
    id: `handoff-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: '提议 session 接力（封印当前 → 续接 fresh 自己）',
    bodyMarkdown: `${proposal.sourceCatId} 想在干净断点封印当前 session，把这份亲手写的交接带给续接的自己。`,
    tone: 'info',
    fields,
    actions: [
      { label: '批准并接力', action: 'handoff:approve', payload: { proposalId: proposal.proposalId } },
      { label: '驳回', action: 'handoff:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}
