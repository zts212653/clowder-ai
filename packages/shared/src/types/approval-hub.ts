/**
 * F246: Approval Hub unified DTO.
 *
 * ApprovalItem is a read-only projection from canonical feature stores
 * (F128 ThreadProposal, F225 SessionHandoffProposal). No lifecycle, no
 * persistence — computed at Hub read-time via per-feature adapters and
 * discarded after response. (KD-3: v1 query aggregation)
 */

/** Features whose proposals can appear in the Approval Hub. */
export type ApprovalFeatureId = 'F128' | 'F225' | 'F193' | 'F231';

/**
 * Hub display status — a projection, not a canonical store status.
 * 'stale' is computed client-side: expiresAt < Date.now() → stale.
 * Approved/rejected items are excluded by adapter (AC-A10).
 */
export type ApprovalItemStatus = 'pending' | 'stale';

/** Unified DTO that all feature adapters produce. */
export interface ApprovalItem {
  /** Canonical proposal ID from the source store. */
  proposalId: string;
  /** Which feature this came from (router key for approve/reject). */
  sourceFeatureId: ApprovalFeatureId;
  /** Thread where the proposal card lives. */
  sourceThreadId: string;
  /** Message ID of the proposal card (for jump-to). */
  sourceMessageId?: string;
  /** Cat that created the proposal. */
  requesterCatId: string;
  /** User who owns this approval (Hub filters by this, AC-A7). */
  ownerUserId: string;
  /** pending or stale (computed: expiresAt < now). */
  status: ApprovalItemStatus;
  /** Human-readable summary for the Hub list. */
  summary: string;
  /** Feature-specific detail fields for rendering / inline editing. */
  detail: Record<string, unknown>;
  /** Hub can approve/reject inline (true for F128, false for F225). */
  inlineApprovable: boolean;
  /** Staleness threshold (ms epoch). undefined = never stale (AC-A6). */
  expiresAt?: number;
  /** Creation timestamp from canonical store. */
  createdAt: number;
}
