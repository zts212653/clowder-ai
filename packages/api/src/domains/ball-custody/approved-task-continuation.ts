import { randomUUID } from 'node:crypto';
import type { TaskContractContinuationV1, TaskItem, ThreadProposal } from '@cat-cafe/shared';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import { matchesApprovedTaskIdentity } from './approved-development-proposal.js';
import { approvedGenericTaskContinuation } from './approved-generic-task-proposal.js';
import { deriveApprovedTaskContract } from './approved-task-contract.js';
import type { ApprovedTaskImplementationHistory } from './approved-task-implementation-history.js';

/** Actor coordinates come exclusively from callback authentication. */
export interface ApprovedTaskContinuationInput {
  proposalId: string;
  taskId: string;
  clientRequestId: string;
  actor: { userId: string; catId: string; threadId: string };
}

export interface ContinuationChild {
  id: string;
  createdBy: string;
  parentThreadId?: string;
  createdFromProposalId?: string;
  deletedAt?: number | null;
  projectPath: string;
}

export function matchesContinuationChild(
  proposal: Pick<ThreadProposal, 'proposalId' | 'createdThreadId' | 'createdBy' | 'parentThreadId' | 'projectPath'>,
  child: ContinuationChild,
): boolean {
  return (
    child.id === proposal.createdThreadId &&
    child.createdFromProposalId === proposal.proposalId &&
    child.parentThreadId === proposal.parentThreadId &&
    child.createdBy === proposal.createdBy &&
    child.deletedAt == null &&
    child.projectPath === proposal.projectPath
  );
}

/** Synchronous reads let the in-memory engine validate and append in one event-loop turn. */
export interface MemoryContinuationAuthority {
  task(taskId: string): TaskItem | null;
  child(threadId: string): ContinuationChild | null;
  implementations(taskId: string, tenant: string): readonly ActionSuccessorLease[];
}

export type ApprovedTaskContinuationResult =
  | { outcome: 'continued' | 'replayed'; receipt: TaskContractContinuationV1 }
  | {
      outcome: 'rejected';
      reason:
        | 'unavailable'
        | 'scope_present'
        | 'authority_mismatch'
        | 'contract_invalid'
        | 'contract_drift'
        | 'already_implemented'
        | 'idempotency_conflict'
        | 'concurrent_change';
    };

export function implementationUsedProposal(
  lease: ApprovedTaskImplementationHistory | null,
  proposal: ThreadProposal,
): boolean {
  if (
    !lease ||
    lease.actionFamily !== 'implement' ||
    lease.tenantScope !== proposal.createdBy ||
    lease.subjectRef !== `subject:task:${proposal.subjectTaskId}`
  )
    return false;
  return (
    lease.holderThreadId === proposal.createdThreadId ||
    lease.evidenceRefs.some((ref) => ref.startsWith(`proposal:${proposal.proposalId}:`)) ||
    lease.returnTransitions.some((t) => t.rejectingThreadId === proposal.createdThreadId) ||
    lease.replacementTransitions.some(
      (t) => t.fromHolderThreadId === proposal.createdThreadId || t.toHolderThreadId === proposal.createdThreadId,
    )
  );
}

function isOriginalOwnerContinuation(
  input: ApprovedTaskContinuationInput,
  proposal: ThreadProposal,
  task: TaskItem,
  child: ContinuationChild,
): boolean {
  return (
    proposal.proposalId === input.proposalId &&
    task.id === input.taskId &&
    task.status !== 'done' &&
    matchesApprovedTaskIdentity(proposal, task) &&
    proposal.subjectTaskTitle === task.title &&
    input.actor.userId === task.userId &&
    input.actor.catId === task.ownerCatId &&
    input.actor.threadId === task.threadId &&
    matchesContinuationChild(proposal, child)
  );
}

/** Pure decision reused by both storage engines inside their atomic commit boundary. */
export function decideApprovedTaskContinuation(
  input: ApprovedTaskContinuationInput,
  proposal: ThreadProposal | null,
  task: TaskItem | null,
  child: ContinuationChild | null,
  implementation: ApprovedTaskImplementationHistory | null,
): ApprovedTaskContinuationResult {
  const reject = (
    reason: Extract<ApprovedTaskContinuationResult, { outcome: 'rejected' }>['reason'],
  ): ApprovedTaskContinuationResult => ({ outcome: 'rejected', reason });
  if (!proposal || !task || !child) return reject('unavailable');
  if (proposal.approvalContractInvalid) return reject('contract_invalid');
  if (proposal.approvedDevelopmentScope !== undefined || task.entrustedWork?.developmentScope !== undefined)
    return reject('scope_present');
  if (!isOriginalOwnerContinuation(input, proposal, task, child)) return reject('authority_mismatch');
  if (proposal.publication && !['anchored', 'legacy_unanchored'].includes(proposal.publication.state))
    return reject('contract_invalid');
  const contract = deriveApprovedTaskContract(proposal);
  if (!contract) return reject('contract_invalid');
  if (proposal.approvedTaskContract && proposal.approvedTaskContract.digest !== contract.digest)
    return reject('contract_drift');
  const receipt = proposal.taskContractContinuation;
  if (receipt) {
    if (receipt.clientRequestId !== input.clientRequestId || receipt.taskId !== input.taskId)
      return reject('idempotency_conflict');
    if (!approvedGenericTaskContinuation(proposal, task)) return reject('contract_drift');
    return { outcome: 'replayed', receipt: structuredClone(receipt) };
  }
  if (implementationUsedProposal(implementation, proposal)) return reject('already_implemented');
  return {
    outcome: 'continued',
    receipt: {
      v: 1,
      receiptId: randomUUID(),
      proposalId: proposal.proposalId,
      taskId: task.id,
      taskTitle: task.title,
      ownerCatId: input.actor.catId,
      ownerThreadId: task.threadId,
      userId: input.actor.userId,
      childThreadId: child.id,
      targetCatIds: [...proposal.preferredCats],
      contractDigest: contract.digest,
      approvalContractKind: proposal.approvedTaskContract ? 'frozen' : 'legacy',
      clientRequestId: input.clientRequestId,
      issuedAt: Date.now(),
    },
  };
}
