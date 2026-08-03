import type { ApprovalItem, ScheduleMutationProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { ScheduleMutationProposalStore } from '../../../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

const DEFAULT_SETTLED_LIMIT = 50;

export class F139ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F139' as const;

  constructor(private readonly store: ScheduleMutationProposalStore) {}

  listPending(userId: string): ApprovalItem[] {
    return compactApprovalProjections(this.store.listPending(userId).map(toItem));
  }

  listSettled(userId: string, opts?: ListSettledOpts): SettledApprovalItem[] {
    return compactApprovalProjections(
      this.store.listSettledByUser(userId, opts?.limit ?? DEFAULT_SETTLED_LIMIT).map(toSettledItem),
    );
  }
}

function toItem(proposal: ScheduleMutationProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(proposal, {});
  if (!navigation) return null;
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F139',
    requesterCatId: proposal.requesterCatId,
    ownerUserId: proposal.ownerUserId,
    status: 'pending',
    summary: summary(proposal),
    detail: detail(proposal),
    navigation,
    inlineApprovable: true,
    decisionMode: proposal.status === 'applying' ? 'resume-only' : 'approve-reject',
    createdAt: proposal.createdAt,
  };
}

function toSettledItem(proposal: ScheduleMutationProposal): SettledApprovalItem | null {
  if (proposal.status !== 'approved' && proposal.status !== 'rejected') {
    throw new Error(`F139 settled projection received ${proposal.status}`);
  }
  const navigation = projectApprovalNavigation(proposal, {});
  if (!navigation) return null;
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F139',
    requesterCatId: proposal.requesterCatId,
    ownerUserId: proposal.ownerUserId,
    status: proposal.status,
    summary: summary(proposal),
    detail: detail(proposal),
    navigation,
    decidedAt: proposal.approvedAt ?? proposal.rejectedAt ?? 0,
    decidedBy: proposal.approvedBy ?? proposal.rejectedBy ?? '',
    createdAt: proposal.createdAt,
  };
}

function summary(proposal: ScheduleMutationProposal): string {
  if (proposal.mutation.kind === 'create') {
    return `Create schedule: ${proposal.mutation.task.display.label}`;
  }
  return `Delete schedule: ${proposal.mutation.taskSnapshot.display.label}`;
}

function detail(proposal: ScheduleMutationProposal): Record<string, unknown> {
  if (proposal.mutation.kind === 'create') {
    return {
      mutationKind: 'create',
      taskId: proposal.mutation.task.id,
      templateId: proposal.mutation.task.templateId,
      trigger: proposal.mutation.task.trigger,
      deliveryThreadId: proposal.mutation.task.deliveryThreadId,
    };
  }
  return {
    mutationKind: 'delete',
    taskId: proposal.mutation.taskId,
    expectedFingerprint: proposal.mutation.expectedFingerprint,
    trigger: proposal.mutation.taskSnapshot.trigger,
    deliveryThreadId: proposal.mutation.taskSnapshot.deliveryThreadId,
  };
}
