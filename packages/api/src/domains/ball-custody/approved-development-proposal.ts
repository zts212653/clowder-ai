import type { ApprovedTaskContractV1, TaskContractContinuationV1 } from '@cat-cafe/shared';
import { type DevelopmentScopeSnapshot, sameDevelopmentScopeSnapshot } from './action-subject-delegate-contract.js';
import type { CompleteProposalContract } from './approved-task-contract.js';

export interface ApprovedDevelopmentProposalSnapshot
  extends Partial<Omit<CompleteProposalContract, 'approvedDevelopmentScope'>> {
  readonly approvedTaskContract?: ApprovedTaskContractV1;
  readonly taskContractContinuation?: TaskContractContinuationV1;
  readonly proposalId: string;
  readonly status: string;
  readonly createdThreadId?: string;
  readonly sourceThreadId: string;
  readonly sourceCatId: string;
  readonly parentThreadId: string;
  readonly createdBy: string;
  readonly approvedBy?: string;
  readonly approvedAt?: number;
  readonly preferredCats?: ReadonlyArray<string>;
  readonly subjectTaskId?: string;
  readonly approvedDevelopmentScope?: DevelopmentScopeSnapshot;
}

export interface DevelopmentTaskAuthoritySnapshot {
  readonly id: string;
  readonly title?: string;
  readonly threadId: string;
  readonly ownerCatId?: string | null;
  readonly userId?: string;
  readonly developmentScope?: DevelopmentScopeSnapshot;
}

/** One exact, current Task relation through either its legacy source or approved parent thread. */
export function matchesApprovedTaskIdentity(
  proposal: ApprovedDevelopmentProposalSnapshot,
  task: DevelopmentTaskAuthoritySnapshot,
): boolean {
  return Boolean(
    task.ownerCatId &&
      task.userId &&
      !proposal.approvalContractInvalid &&
      proposal.status === 'approved' &&
      proposal.createdThreadId &&
      (proposal.sourceThreadId === task.threadId || proposal.parentThreadId === task.threadId) &&
      proposal.sourceCatId === task.ownerCatId &&
      proposal.createdBy === task.userId &&
      proposal.approvedBy === task.userId &&
      Number.isFinite(proposal.approvedAt) &&
      proposal.subjectTaskId === task.id,
  );
}

export function isApprovedDevelopmentProposalForTask(
  proposal: ApprovedDevelopmentProposalSnapshot,
  task: DevelopmentTaskAuthoritySnapshot,
): boolean {
  return (
    matchesApprovedTaskIdentity(proposal, task) &&
    sameDevelopmentScopeSnapshot(proposal.approvedDevelopmentScope, task.developmentScope)
  );
}
