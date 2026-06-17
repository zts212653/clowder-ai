/**
 * F231 Phase C: Profile update proposal types.
 *
 * Cats propose a capsule/primer update via `cat_cafe_propose_profile_update`;
 * the operator sees a card and approves/rejects. Only on approve does the backend
 * write the per-cat primer + provenance (KD-12 cost-tiered: low-cost per-cat
 * primer writes go here; high-cost shared-capsule promotion is C2 / KD-15).
 *
 * State machine mirrors F128 ThreadProposal (review-proven edges):
 *   pending → approving → approved   (claim then finalize, atomic against reject)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on write failure)
 *
 * AC-C1 differences from ThreadProposal: approve writes a file (not a thread),
 * with a P1-1 two-path crash checkpoint and a P1-2 optimistic lock on the
 * target primer's content hash (per-target lock guards the approve critical
 * section against concurrent same-primer approves — see decision route, KD-15).
 */

import type { CatId } from './ids.js';

/** AC-C1 only writes the per-cat primer (low-cost). `'capsule'` (high-cost, shared) is C2. */
export type ProfileUpdateTargetLayer = 'primer';

export type ProfileUpdateProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected';

/**
 * KD-9 whitelist source — where the relationship signal came from.
 * AC-C1: manual entry only (`cat-declared` / `cvo-instructed`); NO classifier-inferred kinds.
 */
export interface ProfileUpdateSignalProvenance {
  kind: 'cat-declared' | 'cvo-instructed';
  sourceThreadId: string;
  sourceMessageId?: string;
}

/**
 * A profile-update proposal created by a cat, awaiting operator decision.
 */
export interface ProfileUpdateProposal {
  proposalId: string;
  status: ProfileUpdateProposalStatus;

  // Source / lineage
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceCatId: CatId; // owner cat (primer is per-cat)

  // Target
  targetLayer: ProfileUpdateTargetLayer;
  targetPath: string; // resolved primer file path, pinned at propose time

  // Payload
  beforeContent: string; // current primer content at propose time (diff + audit)
  baseContentHash: string; // P1-2 optimistic lock: hash of current primer at propose; approve re-reads & compares
  afterContent: string; // proposed new content
  rationale: string; // why this update (shown on the card)
  signalProvenance: ProfileUpdateSignalProvenance;

  // Audit — creation
  createdBy: string;
  createdAt: number;

  /** Visibility commit marker (same role as ThreadProposal.cardMessageId). */
  cardMessageId?: string;

  // Audit — approval lifecycle
  approvedBy?: string;
  approvedAt?: number;
  /** Unix ms of claimForApproval (pending → approving); enables stale-claim recovery. */
  claimedAt?: number;

  /**
   * P1-1 partial-commit checkpoint: BOTH recorded BEFORE finalize via recordCheckpoint().
   * Deterministic (proposalId-based) paths → writes are overwrite-idempotent on retry.
   */
  writtenPath?: string; // primer written (checkpointed before finalize)
  provenancePath?: string; // provenance written (checkpointed before finalize)

  // Audit — rejection
  rejectedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;
}

/** Fields the operator may override at approve time (AC-C1: afterContent edit only). */
export interface ProfileUpdateApproveOverrides {
  afterContent?: string;
}
