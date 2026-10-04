/**
 * F167 × F322: Real `TaskApprovedDelegateProvider` backed by the
 * authoritative proposal store.
 *
 * Architecture:
 *   - `proposalStore.get(proposalId)` verifies proposal status + lifecycle
 *   - `bindingProvider` maps a specific task → the proposalId that
 *     grants delegation for it (task-level scoping, not thread-pooled)
 *   - Authorized delegate catIds come from `proposal.preferredCats` —
 *     the explicit execution target set at proposal creation / operator approval,
 *     not the current thread roster (which may include reviewers, coordinators,
 *     or other cats who joined after approval).
 *
 * Fail-closed at every step: missing binding, missing/rejected/withdrawn
 * proposal, thread mismatch, tenant mismatch, owner change since approval,
 * or empty preferredCats all yield empty delegates.
 */

import type {
  ApprovedDelegate,
  DevelopmentScopeSnapshot,
  TaskApprovedDelegateProvider,
} from './action-subject-delegate-contract.js';

/**
 * Maps a task to the proposal that grants delegation for it, along with
 * the ownerCatId that was current when the delegation was approved.
 *
 * This binding is the bridge between the task layer (which knows task IDs)
 * and the proposal layer (which knows thread-level approvals). Without
 * this binding, the provider cannot prove task-level delegation → fail closed.
 *
 * The `approvedUnderOwner` field enables owner-change invalidation (P1-2):
 * if the task's current owner differs from the owner at approval time,
 * the delegation is no longer proven valid.
 */
export interface DelegateProposalBinding {
  readonly proposalId: string;
  readonly approvedUnderOwner: string;
}

/**
 * Resolves the delegation binding for a specific task. Implementations
 * typically query a task metadata index or workflow state.
 *
 * `taskThreadId` is the thread where the task lives (the parent/source
 * thread), not the child thread. The caller (ProposalStoreDelegateProvider)
 * already resolved the task and passes this through to avoid redundant
 * lookups.
 */
export interface DelegateBindingProvider {
  getBindingForTask(taskId: string, taskThreadId: string, tenantScope: string): Promise<DelegateProposalBinding | null>;
}

/**
 * Minimal proposal shape consumed by the provider. Matches a subset of
 * `ThreadProposal` from `@cat-cafe/shared` — the provider does not need
 * the full proposal type, only the fields required for verification.
 *
 * `preferredCats` is the authoritative list of cats explicitly approved
 * for execution in the child thread. It is set at proposal creation and
 * may be overridden by the operator at approval time. Only cats in this list
 * receive delegate standing — later thread participants (reviewers,
 * coordinators) do NOT gain delegation by joining.
 *
 * When `preferredCats` is empty or absent, no cats have been explicitly
 * authorized → fail closed.
 */
export interface ProposalSnapshot {
  readonly proposalId: string;
  readonly status: string;
  readonly createdThreadId?: string;
  readonly sourceThreadId: string;
  readonly createdBy: string;
  readonly preferredCats?: ReadonlyArray<string>;
  /** F167 R5: immutable scope snapshot from creation time. Absent → no delegate authority. */
  readonly approvedDevelopmentScope?: DevelopmentScopeSnapshot;
}

export class ProposalStoreDelegateProvider implements TaskApprovedDelegateProvider {
  constructor(
    private readonly proposalStore: { get(id: string): Promise<ProposalSnapshot | null> },
    private readonly bindingProvider: DelegateBindingProvider,
  ) {}

  async getForTask(
    taskId: string,
    taskThreadId: string,
    currentOwnerCatId: string,
    tenantScope: string,
    currentDevelopmentScope?: DevelopmentScopeSnapshot,
  ): Promise<ReadonlyArray<ApprovedDelegate>> {
    // Step 1: Find the delegation binding for this specific task.
    // Fail-closed: no binding → no delegation proof → empty.
    const binding = await this.bindingProvider.getBindingForTask(taskId, taskThreadId, tenantScope);
    if (!binding) return [];

    // Step 2 (P1-2): Verify the task's current owner matches the owner
    // under which the delegation was approved. Owner change invalidates
    // the delegation — the new owner hasn't authorized this delegate.
    if (binding.approvedUnderOwner !== currentOwnerCatId) return [];

    // Step 3: Verify proposal in authoritative store.
    // Missing or tampered proposal → fail closed.
    const proposal = await this.proposalStore.get(binding.proposalId);
    if (!proposal) return [];

    // Step 4: Verify proposal is approved with a created child thread.
    // Non-approved (rejected/withdrawn) or no child thread → fail closed.
    if (proposal.status !== 'approved') return [];
    if (!proposal.createdThreadId) return [];

    // Step 5: Verify proposal originated from the task's thread.
    // A proposal from a different thread cannot grant delegation for
    // tasks in this thread.
    if (proposal.sourceThreadId !== taskThreadId) return [];

    // Step 6: Verify tenant — the proposal creator must be the tenant
    // owner of the task.
    if (proposal.createdBy !== tenantScope) return [];

    // Step 7 (R5): Development scope drift detection.
    // The proposal's approvedDevelopmentScope is the immutable snapshot from
    // creation time. If the task's current scope differs from the approved
    // snapshot, the delegation is stale — the accepted work unit, source, or
    // revision has changed since approval.
    //
    // Fail-closed cases:
    //   a) Proposal has no scope → no delegate authority (tasks without
    //      entrustedWork.developmentScope at proposal time cannot delegate).
    //   b) Task has no current scope → scope was removed after approval → stale.
    //   c) Any of the 5 fields differ → scope drift → stale.
    if (!proposal.approvedDevelopmentScope) return [];
    if (!currentDevelopmentScope) return [];
    const approved = proposal.approvedDevelopmentScope;
    if (
      approved.featureRef !== currentDevelopmentScope.featureRef ||
      approved.phaseKey !== currentDevelopmentScope.phaseKey ||
      approved.workUnitRef !== currentDevelopmentScope.workUnitRef ||
      approved.acceptedSourceRef !== currentDevelopmentScope.acceptedSourceRef ||
      approved.acceptedRevision !== currentDevelopmentScope.acceptedRevision
    ) {
      return [];
    }

    // Step 8: Use proposal's preferredCats — the explicit execution target
    // set at proposal creation / operator approval. This is NOT the current
    // thread roster. A cat that joined the child thread later (reviewer,
    // coordinator, observer) does NOT gain delegation standing.
    // Empty or absent preferredCats → fail closed.
    const authorizedCats = proposal.preferredCats;
    if (!authorizedCats || authorizedCats.length === 0) return [];

    return authorizedCats.map((catId) => ({
      catId,
      threadId: proposal.createdThreadId!,
      evidenceRef: `proposal:${binding.proposalId}:approved:thread:${proposal.createdThreadId}:cat:${catId}`,
    }));
  }
}

/**
 * Minimal proposal shape returned by listing. Only the fields needed for
 * binding resolution — not the full ThreadProposal.
 */
export interface ProposalListItem {
  readonly proposalId: string;
  readonly status: string;
  readonly createdThreadId?: string;
  readonly createdBy: string;
  readonly sourceCatId: string;
  /** F167 × F322: task binding — absent on legacy proposals. */
  readonly subjectTaskId?: string;
}

/**
 * F167 × F322: Production `DelegateBindingProvider` backed by the thread→
 * proposal chain in the authoritative proposal store.
 *
 * Resolution path:
 *   1. `proposalLister.listByThread(taskThreadId)` returns all proposals
 *      raised from the task's parent thread.
 *   2. Filter to proposals that are `approved` with a `createdThreadId`
 *      AND whose `subjectTaskId` matches the requested `taskId`.
 *      This ensures task-level isolation: proposals for task A cannot
 *      authorize delegation for task B in the same thread.
 *   3. If exactly one match → unambiguous binding. If zero or multiple
 *      matches → fail closed.
 *   4. Verify tenant: `proposal.createdBy` must match the task's tenant
 *      scope. Different tenant → no delegation authority.
 *   5. `approvedUnderOwner` is set to `proposal.sourceCatId` — the cat
 *      that proposed the delegation. ProposalStoreDelegateProvider.getForTask
 *      Step 2 compares this against the task's current ownerCatId — if the
 *      owner changed from the proposer, the delegation is invalidated (P1-2).
 *
 * Fail-closed at every step: no proposals, no task-matching proposals,
 * ambiguous matches, tenant mismatch, or proposals without child threads
 * all yield null. Legacy proposals without `subjectTaskId` are excluded —
 * they cannot prove task-level delegation.
 */
export class ThreadDelegateBindingProvider implements DelegateBindingProvider {
  constructor(
    private readonly proposalLister: {
      listByThread(threadId: string, limit?: number): Promise<ReadonlyArray<ProposalListItem>>;
    },
  ) {}

  async getBindingForTask(
    taskId: string,
    taskThreadId: string,
    tenantScope: string,
  ): Promise<DelegateProposalBinding | null> {
    // Step 1: List all proposals from the task's parent thread.
    const proposals = await this.proposalLister.listByThread(taskThreadId);

    // Step 2: Filter to approved proposals that:
    //   a) Created a child thread (createdThreadId is set)
    //   b) Are explicitly bound to THIS task via subjectTaskId
    // Proposals without subjectTaskId are legacy — they cannot prove
    // task-level delegation and are excluded (fail closed).
    const taskBound = proposals.filter(
      (p) => p.status === 'approved' && p.createdThreadId && p.subjectTaskId === taskId,
    );

    // Step 3: Require exactly one match. Zero = no task-bound delegation.
    // Multiple = ambiguous (shouldn't happen with unique task binding,
    // but fail closed if it does).
    if (taskBound.length !== 1) return null;

    const proposal = taskBound[0];

    // Step 4: Verify tenant. The proposal creator must be the same
    // tenant that owns the task. Different tenant → no delegation.
    if (proposal.createdBy !== tenantScope) return null;

    // Step 5: Return binding with the proposing cat as the "approved
    // under" owner.
    return {
      proposalId: proposal.proposalId,
      approvedUnderOwner: proposal.sourceCatId,
    };
  }
}
