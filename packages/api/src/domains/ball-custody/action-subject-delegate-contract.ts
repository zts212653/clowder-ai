/**
 * F167 × F322: Delegate contract types for approved-child delegation.
 *
 * Extracted from ActionSubjectTruthResolver to keep file sizes under the
 * 350-line hard limit. These are provider-facing contracts — consumed by
 * ProposalStoreDelegateProvider, composition root, and tests.
 */

/**
 * A operator-approved delegate that may operate on a task subject on behalf of
 * the canonical owner. The (catId, threadId) pair must match exactly; tenant
 * scope is not relaxed by delegation.
 */
export interface ApprovedDelegate {
  readonly catId: string;
  readonly threadId: string;
  readonly evidenceRef: string;
}

/**
 * F167 × F322: Resolves operator-approved delegates for a specific task from the
 * authoritative proposal store. The implementation must verify:
 *   1. The proposal is in `approved` status with a valid `createdThreadId`.
 *   2. The delegation is scoped to the exact `taskId`, not pooled across all
 *      tasks in the same thread (P1-1: same-thread multi-task isolation).
 *   3. The `currentOwnerCatId` matches the owner context under which the
 *      delegation was approved (P1-2: owner-change invalidation).
 *
 * Fail-closed: missing, rejected, withdrawn, owner-mismatched, or
 * unresolvable proposals yield an empty result.
 *
 * Approved proposals are irrevocable in the current product contract
 * (ProposalStatus has no approved→revoked transition), so a valid
 * `approved` status is durable truth — but the delegation's applicability
 * to a specific task under a specific owner is not irrevocable.
 */
/**
 * Opaque development scope snapshot used for scope-drift detection at claim time.
 * Structurally a subset of DevelopmentScopeV1 — only the fields needed for comparison.
 */
export interface DevelopmentScopeSnapshot {
  readonly featureRef: string;
  readonly phaseKey: string;
  readonly workUnitRef: string;
  readonly acceptedSourceRef: string;
  readonly acceptedRevision: string;
}

export interface TaskApprovedDelegateProvider {
  getForTask(
    taskId: string,
    taskThreadId: string,
    currentOwnerCatId: string,
    tenantScope: string,
    /** F167 R5: current task scope for drift detection. Absent → tasks without scope get no delegates. */
    currentDevelopmentScope?: DevelopmentScopeSnapshot,
  ): Promise<ReadonlyArray<ApprovedDelegate>>;
}

/**
 * Narrow snapshot of a task used for action subject truth resolution.
 */
export interface TaskActionSnapshot {
  id: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  ownerCatId: string | null;
  threadId: string;
  userId?: string;
  updatedAt: number;
  /** F167 R5: current development scope for delegation scope-drift detection. */
  developmentScope?: DevelopmentScopeSnapshot;
}

export interface TaskActionTruthProvider {
  get(taskId: string): Promise<TaskActionSnapshot | null>;
}
