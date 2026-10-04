/**
 * F246: Approval Hub per-feature adapter port.
 *
 * Each adapter maps a canonical feature store's pending proposals to the
 * unified ApprovalItem DTO. Internal-only (AC-A8) — not exported through
 * shared or used by the frontend directly.
 */

import type { ApprovalItem, ApprovalProducerId, SettledApprovalItem } from '@cat-cafe/shared';

export interface ListSettledOpts {
  /** Maximum items to return. Defaults to 50. */
  limit?: number;
}

/** Pending aggregation has no source page. Read the full representable owner index before paging the union. */
export const ALL_PENDING_APPROVALS_LIMIT = Number.MAX_SAFE_INTEGER;

export interface IApprovalAdapter {
  readonly featureId: ApprovalProducerId;
  /** Fetch ALL legal pending proposals for this user; canonical store default page limits must not truncate this read. */
  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]>;
  /**
   * F246 Phase F: Fetch settled (approved|rejected) proposals for history view.
   * Optional — adapters that don't retain decided data return [].
   */
  listSettled?(userId: string, opts?: ListSettledOpts): SettledApprovalItem[] | Promise<SettledApprovalItem[]>;
}
