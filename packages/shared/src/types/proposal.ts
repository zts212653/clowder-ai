/**
 * F128: Thread proposal types.
 *
 * Cats propose a new thread via `cat_cafe_propose_thread`; the user
 * sees a card, edits if needed, and approves or rejects. Only on
 * approve does the backend actually create a thread.
 */

import type { CatId } from './ids.js';

/**
 * Status lifecycle:
 *   pending → approving → approved   (claim then finalize, atomic against reject)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on thread-creation failure)
 */
export type ProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected';

/**
 * F128 Phase Y reporting modes — the contract for whether (and how) a sub-thread
 * reports back to its source thread. Default is `none` (autonomous, AC-Y6).
 * Fixed at proposal time — dynamic switching is NOT supported (C-Y1).
 *
 * - `none` (UI: autonomous): source thread holds no receipt responsibility;
 *   critical events still escalate per house rules (C-Y2).
 * - `final-only`: one summary on completion.
 * - `state-transitions`: report at each phase boundary.
 * - `blocking-ack`: downstream waits for source-thread ack at each blocker (C-Y3).
 */
export type ReportingMode = 'none' | 'final-only' | 'state-transitions' | 'blocking-ack';

/**
 * A thread proposal created by a cat, awaiting user decision.
 */
export interface ThreadProposal {
  proposalId: string;
  status: ProposalStatus;

  // Source / lineage
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceCatId: CatId;

  // Prefilled fields (user may override at approve time)
  title: string;
  reason: string;
  parentThreadId: string; // defaults to sourceThreadId at create time
  preferredCats: CatId[]; // empty array if none
  initialMessage?: string;
  /**
   * F128 Phase Y: how this sub-thread reports back to its source thread.
   * Optional for backward-compat with pre-Phase-Y proposals; readers treat
   * `undefined` as the default `none` (autonomous). Fixed at create time — NOT
   * editable via ProposalApproveOverrides (C-Y1: no dynamic switching).
   */
  reportingMode?: ReportingMode;
  projectPath: string;

  // Audit — creation
  createdBy: string;
  createdAt: number;

  /**
   * Message id of the rich proposal card that was successfully appended to the source thread.
   * Acts as the visibility commit marker: until this is set, the proposal is in-flight and
   * MUST NOT be returned via the dedup fast path. Concurrent retries between create() and
   * card append would otherwise hand callers a phantom proposalId that gets cleaned up.
   */
  cardMessageId?: string;

  // Audit — approval outcome
  approvedBy?: string;
  approvedAt?: number;
  createdThreadId?: string;
  /**
   * Unix ms when claimForApproval transitioned status pending → approving.
   * If the process crashes between claim and finalize, this lets approve/reject
   * detect a stale claim (now - claimedAt > STALE_APPROVING_MS) and forcibly
   * release it so the proposal isn't stuck forever.
   */
  claimedAt?: number;

  // Audit — rejection outcome
  rejectedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;
}

/**
 * Fields the user may override at approve time.
 * `null` means "clear the field" for preferredCats/initialMessage;
 * `undefined` means "keep the proposal's prefilled value".
 */
export interface ProposalApproveOverrides {
  title?: string;
  parentThreadId?: string;
  preferredCats?: CatId[];
  initialMessage?: string | null;
}
