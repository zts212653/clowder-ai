/**
 * F225: Cat-initiated session handoff proposal types.
 *
 * 猫在干净断点主动提议封印当前 session → co-creator gate → spawn 同 thread 同 catId
 * 续接 + 注入猫亲手写的五件套交接留言。
 *
 * 与 F128 ThreadProposal 的关键差异（KD-5）：不复用 ThreadProposal shape（建-thread
 * 专用）。复用 claimForApproval 的 CAS 思路，但 spawn 目标是续接同 session、不是建 thread。
 *
 * Approve 用 commit-point 模型（KD-8/9）：
 *   pre-commit（claim → 校验 active → 持久化 note）可 fail/expire
 *   commit point = requestSeal accepted（不可逆，置 sealing + 清 active pointer）
 *   post-commit（enqueue → finalize）只 recover-forward
 */

import type { CatId } from './ids.js';

/**
 * 五件套交接留言——猫亲手写给续接自己的高保真意图。
 * 落 SessionRecord.catHandoffNote（typed，非 continuityCapsule:unknown，KD-4）。
 * 带 proposalId 让 commit point 可从 session 侧反推（KD-9 crash recovery）。
 */
export interface CatHandoffNote {
  /** 关联的 handoff proposal id（commit-point 反推 key） */
  proposalId: string;
  /** 被封印的源 session id */
  sourceSessionId: string;
  /** 五件套：已完成 */
  done: string;
  /** 五件套：worktree + 分支 */
  worktreeBranch?: string;
  /** 五件套：相关 commits */
  commits?: string[];
  /** 五件套：下一步 */
  nextSteps: string;
  /** 五件套：坑 / 注意 */
  gotchas?: string;
  /** note 持久化时间戳 */
  persistedAt: number;
}

/**
 * Status lifecycle（commit-point 模型）：
 *   pending → approving → approved   (claim → 持久化 note → requestSeal → enqueue → finalize)
 *   pending → rejected               (gate reject, one-shot)
 *   pending/approving → expired      (cooldown / stale / session 已变)
 */
export type HandoffProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'expired';

export interface SessionHandoffProposal {
  /** discriminant — 区别于 ThreadProposal（KD-5） */
  kind: 'session_handoff';
  proposalId: string;
  status: HandoffProposalStatus;
  sourceThreadId: string;
  /** 要封印的当前 session */
  sourceSessionId: string;
  sourceCatId: CatId;
  userId: string;
  /** 猫亲手写的五件套留言 */
  note: CatHandoffNote;

  // ── commit-point checkpoints（KD-8/9，crash recovery 按这些续跑）──
  /** pre-commit: note 持久化完成 */
  handoffNotePersistedAt?: number;
  /** commit point: requestSeal accepted（不可逆，自此只 recover-forward） */
  sealedSessionId?: string;
  sealAcceptedAt?: number;
  /** post-commit: continuation 已 enqueue（idempotency） */
  continuationEntryId?: string;

  /** 确认卡 messageId（可见性 gate） */
  cardMessageId?: string;

  createdAt: number;
  updatedAt: number;
}
