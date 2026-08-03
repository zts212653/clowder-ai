/**
 * F221 Phase B: Taste Capture Loop — proposal types.
 *
 * Cats propose taste signal captures; operator approves/rejects in the F246 Approval Hub.
 * Approved proposals are written to `docs/taste/vignettes/` as permanent vignettes.
 *
 * State machine (same family as F231 ProfileUpdateProposal):
 *   pending → approving → approved   (claim then finalize)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on writer failure)
 */

import type { ApprovalOriginRef, ApprovalPublication } from './approval-hub.js';

export type TasteProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected';

/**
 * Taste signal dimensions — which axis of operator preference this vignette captures.
 * Each maps to a section in `docs/taste/index.md`.
 */
export type TasteDimension =
  | 'relationship-stance'
  | 'cognitive-honesty'
  | 'architecture-aesthetics'
  | 'visual-quality'
  | 'authentic-expression'
  | 'system-philosophy'
  | 'creative-craft';

export interface TasteProposal {
  /** Unique proposal ID (generated server-side). */
  id: string;
  /** operator userId — server-derived from invocation context, not client-trusted. */
  userId: string;
  /** Cat that proposed this taste signal — server-derived. */
  catId: string;
  /** Thread where the taste signal was observed. */
  threadId: string;
  /** Message that triggered the observation (audit trail). */
  sourceMessageId?: string;

  /** What happened — the context that triggered the observation. */
  scene: string;
  /** operator verbatim words. */
  quote: string;
  /** Search keywords for later retrieval. */
  tags: string[];
  /** Which taste axis this captures. */
  dimension: TasteDimension;
  /** Whether this vignette contains sensitive/private content. */
  privacy: 'public' | 'sensitive';

  /** Current lifecycle status. */
  status: TasteProposalStatus;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Client-provided idempotency key. */
  clientRequestId?: string;
  /** Canonical approval origin persisted for staged recovery retries. */
  approvalOriginRef?: ApprovalOriginRef;

  // ── Settled fields (populated on approve/reject) ──

  /** Epoch ms when operator approved. */
  approvedAt?: number;
  /** userId of the approver. */
  approvedBy?: string;
  /** Epoch ms when operator rejected. */
  rejectedAt?: number;
  /** userId of the rejecter. */
  rejectedBy?: string;
  /** operator's reason for rejection. */
  rejectionReason?: string;

  // ── Writer checkpoint (populated after durable write, before final approval) ──

  /** Slug for the written vignette file. */
  vignetteSlug?: string;
  /** Full relative path to the vignette file. */
  vignettePath?: string;
  /** Phase-I publication state; absent only on pre-Phase-I records. */
  publication?: ApprovalPublication;
}
