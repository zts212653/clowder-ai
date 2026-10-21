import type { TaskContractContinuationV1 } from '@cat-cafe/shared';
import {
  type ApprovedDevelopmentProposalSnapshot,
  type DevelopmentTaskAuthoritySnapshot,
  matchesApprovedTaskIdentity,
} from './approved-development-proposal.js';
import { deriveApprovedTaskContract, taskContractContinuationSchema } from './approved-task-contract.js';

/** Scope absence is not authority. Only the immutable continuation of this exact full contract is. */
export function approvedGenericTaskContinuation(
  proposal: ApprovedDevelopmentProposalSnapshot,
  task: DevelopmentTaskAuthoritySnapshot,
): TaskContractContinuationV1 | null {
  if (
    !matchesApprovedTaskIdentity(proposal, task) ||
    proposal.approvedDevelopmentScope !== undefined ||
    task.developmentScope !== undefined ||
    !task.title ||
    task.title !== proposal.subjectTaskTitle
  )
    return null;
  const receipt = taskContractContinuationSchema.safeParse(proposal.taskContractContinuation);
  if (!receipt.success) return null;
  const contract = deriveApprovedTaskContract(proposal);
  if (!contract || (proposal.approvedTaskContract && proposal.approvedTaskContract.digest !== contract.digest))
    return null;
  const r = receipt.data;
  if (
    r.approvalContractKind !== (proposal.approvedTaskContract ? 'frozen' : 'legacy') ||
    r.proposalId !== proposal.proposalId ||
    r.taskId !== task.id ||
    r.taskTitle !== task.title ||
    r.ownerCatId !== task.ownerCatId ||
    r.ownerThreadId !== task.threadId ||
    r.userId !== task.userId ||
    r.childThreadId !== proposal.createdThreadId ||
    r.contractDigest !== contract.digest ||
    JSON.stringify(r.targetCatIds) !== JSON.stringify(proposal.preferredCats)
  )
    return null;
  return r;
}
