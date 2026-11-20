import type { ThreadProposal } from '@cat-cafe/shared';
import { autoStartsApprovedTask } from '../domains/ball-custody/approved-task-contract.js';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ProposalRoutesOptions } from './proposal-route-options.js';

export async function resolveApprovedTaskSeed(
  deps: Pick<ProposalRoutesOptions, 'ordinaryTaskHandoffs' | 'proposalStore'>,
  proposal: ThreadProposal,
  userId: string,
  auth: OwnerAuthProvenance,
  existing?: StoredMessage,
) {
  if (!autoStartsApprovedTask(proposal)) return undefined;
  const service = deps.ordinaryTaskHandoffs;
  const taskId = proposal.subjectTaskId;
  const target = proposal.preferredCats[0];
  const childId = proposal.createdThreadId;
  if (!service || !taskId || !target || !childId || auth !== 'strict')
    throw new OrdinaryTaskHandoffError('task_approval_authority_unavailable');
  if (existing) {
    const handoff = existing.extra?.taskHandoff;
    if (
      !handoff ||
      !('approval' in handoff.issuer) ||
      handoff.issuer.approval.proposalId !== proposal.proposalId ||
      handoff.issuer.approval.receiptId !== proposal.taskContractContinuation?.receiptId ||
      handoff.taskId !== taskId ||
      handoff.targetThreadId !== childId ||
      handoff.targetCatId !== target
    )
      throw new OrdinaryTaskHandoffError('task_approval_carrier_conflict');
    return handoff;
  }

  const { tasks, threads } = service.deps;
  const decision = await deps.proposalStore.continueApprovedTask(
    {
      proposalId: proposal.proposalId,
      taskId,
      clientRequestId: `proposal-approval:${proposal.proposalId}`,
      approvalUserId: userId,
    },
    {
      task(id) {
        const task = tasks.get(id);
        return task instanceof Promise ? null : task;
      },
      child(id) {
        const child = threads.get(id);
        return child instanceof Promise ? null : child;
      },
      // A new approval-only card cannot authorize a previous Memory implementation
      // of this child. Redis retains its historical implementation fence.
      implementations: () => [],
    },
  );
  if (decision.outcome === 'rejected')
    throw new OrdinaryTaskHandoffError(`task_approval_continuation_${decision.reason}`);
  const receipt = decision.receipt;
  if (!receipt.approval) throw new OrdinaryTaskHandoffError('task_approval_receipt_invalid');
  return service.prepare({
    taskId,
    expectedOwnerRevision: receipt.approval.ownerRevision,
    actor: {
      userId: receipt.userId,
      catId: receipt.ownerCatId,
      threadId: receipt.ownerThreadId,
      approval: { proposalId: receipt.proposalId, receiptId: receipt.receiptId },
    },
    issuerCreatedAt: proposal.approvedAt,
    targetCatId: target,
    targetThreadId: childId,
  });
}
