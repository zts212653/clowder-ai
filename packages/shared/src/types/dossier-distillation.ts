/**
 * F208 Phase E: Dossier Distillation Proposal types.
 *
 * Observations (Phase D) accumulate raw operator/peer signals. Distillation promotes
 * those signals into the cat-dossier.md summary layer — but only through operator
 * approval (KD-3: summary layer must be peer/operator judged, not algorithm-generated).
 *
 * This is intentionally NOT F231 `propose_profile_update` (KD-16):
 *   - F231 = relationship primer, writes `private/profile/relationship/{catId}-primer.md`
 *   - F208 = capability profile, writes `docs/team/cat-dossier.md`
 *   - Different target, different granularity, different approval semantics.
 *
 * State machine (simpler than F231 — no file write during approve, KD-18):
 *   pending → approved    (operator approves in Hub)
 *   pending → rejected    (operator rejects in Hub)
 *   approved → applied    (cat applies draft to dossier + git commit)
 *
 * KD-17 contract fields: sourceEvent, sourceId (idempotency), targetCatId,
 * targetFields, evidenceRefs (fail-closed if empty), beforeSnapshot + afterDraft,
 * rationale, status, baseHash (stale-write lock).
 */

import type { CatId } from './ids.js';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type DistillationProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

// ---------------------------------------------------------------------------
// Source event (what triggered the distillation)
// ---------------------------------------------------------------------------

/**
 * AC-E2: only stable event types trigger distillation (FM-1).
 * v1 = feat phase close + review complete. Extend as needed.
 */
export const DISTILLATION_SOURCE_EVENTS = Object.freeze(['feat-phase-close', 'review-complete'] as const);

export type DistillationSourceEvent = (typeof DISTILLATION_SOURCE_EVENTS)[number];

export function isDistillationSourceEvent(v: unknown): v is DistillationSourceEvent {
  return typeof v === 'string' && (DISTILLATION_SOURCE_EVENTS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Evidence reference (must be non-empty per KD-17, fail-closed)
// ---------------------------------------------------------------------------

export interface DistillationEvidenceRef {
  /** What kind of evidence this is. */
  type: 'observation' | 'review' | 'trajectory' | 'cvo-comment';
  /** Evidence anchor ID (e.g., observation ID, review session ID). */
  id: string;
  /** Short human-readable summary for operator display. */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface DossierDistillationProposal {
  proposalId: string;
  status: DistillationProposalStatus;

  // ---- Trigger ----
  /** What event triggered this distillation. */
  sourceEvent: DistillationSourceEvent;
  /**
   * Idempotency key — unique per triggering event instance.
   * e.g., "feat-phase-close:F208:D" or "review-complete:PR#2457"
   * Same sourceId → same proposal (prevents duplicate distillation).
   */
  sourceId: string;

  // ---- Target ----
  /** Which cat's dossier fields are being updated. */
  targetCatId: CatId;
  /**
   * Which dossier fields are being updated.
   * e.g., ["nativePeakAbilities", "blindSpots"]
   */
  targetFields: string[];

  // ---- Content ----
  /** Current field values at proposal time (for operator diff display). */
  beforeSnapshot: string;
  /** Proposed new field values. */
  afterDraft: string;
  /** Why this update — shown on the Hub card. */
  rationale: string;
  /**
   * Evidence anchors backing this proposal.
   * KD-17: must be non-empty — empty evidenceRefs = proposal creation fails (fail-closed).
   */
  evidenceRefs: DistillationEvidenceRef[];

  // ---- Safety ----
  /**
   * Hash of cat-dossier.md at proposal time.
   * KD-17 stale-write lock: at apply time, re-hash the file and compare.
   * If different → dossier was modified since proposal → reject apply, re-propose.
   */
  baseHash: string;

  // ---- Audit: creation ----
  /** catId that created (proposed) the distillation. */
  createdBy: string;
  createdAt: number;

  // ---- Audit: approval lifecycle ----
  approvedBy?: string;
  approvedAt?: number;

  // ---- Audit: rejection ----
  rejectedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;

  // ---- Audit: application ----
  /** catId that applied the approved draft to cat-dossier.md. */
  appliedBy?: string;
  appliedAt?: number;
  /** Git commit SHA of the dossier update. */
  appliedCommitSha?: string;
}
