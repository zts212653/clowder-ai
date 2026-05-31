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
