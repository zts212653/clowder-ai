/**
 * F246: Approval Hub per-feature adapter port.
 *
 * Each adapter maps a canonical feature store's pending proposals to the
 * unified ApprovalItem DTO. Internal-only (AC-A8) — not exported through
 * shared or used by the frontend directly.
 */

import type { ApprovalFeatureId, ApprovalItem, SettledApprovalItem } from '@cat-cafe/shared';

export interface ListSettledOpts {
  /** Maximum items to return. Defaults to 50. */
  limit?: number;
}

export interface IApprovalAdapter {
  readonly featureId: ApprovalFeatureId;
  /** Fetch pending proposals for this user from the canonical store and map to ApprovalItems. */
  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]>;
  /**
   * F246 Phase F: Fetch settled (approved|rejected) proposals for history view.
   * Optional — adapters that don't retain decided data return [].
   */
  listSettled?(userId: string, opts?: ListSettledOpts): SettledApprovalItem[] | Promise<SettledApprovalItem[]>;
}
