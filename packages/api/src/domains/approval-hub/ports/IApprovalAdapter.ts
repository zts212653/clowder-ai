/**
 * F246: Approval Hub per-feature adapter port.
 *
 * Each adapter maps a canonical feature store's pending proposals to the
 * unified ApprovalItem DTO. Internal-only (AC-A8) — not exported through
 * shared or used by the frontend directly.
 */

import type { ApprovalFeatureId, ApprovalItem } from '@cat-cafe/shared';

export interface IApprovalAdapter {
  readonly featureId: ApprovalFeatureId;
  /** Fetch pending proposals for this user from the canonical store and map to ApprovalItems. */
  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]>;
}
