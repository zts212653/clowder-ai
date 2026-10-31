import type { ApprovalHubItem, RichCardBlock, ScheduleMutationProposal } from '@cat-cafe/shared';

export const coordinate = { threadId: 'schedule-thread', messageId: 'schedule-card' };
export function scheduleProposal(status: ScheduleMutationProposal['status'] = 'pending'): ScheduleMutationProposal {
  return {
    proposalId: 'schedule-1',
    ownerUserId: 'owner-1',
    requesterCatId: 'codex61-sol',
    createdAt: 1000,
    status,
    mutation: {
      kind: 'create',
      relativeOnceDelayMs: 60000,
      task: {
        id: 'private-schedule',
        templateId: 'private-template',
        trigger: { type: 'once', fireAt: 61000 },
        params: { text: 'Read the original evidence.\n'.repeat(40) },
        display: { label: 'Read the evidence', category: 'thread', description: 'Verify the actual source' },
        deliveryThreadId: 'destination',
        enabled: true,
        createdBy: 'codex61-sol',
        createdAt: '2026-10-14T00:00:00Z',
      },
    },
    publication: {
      state: 'anchored',
      envelope: {
        canonicalProposalId: 'schedule-1',
        sourceFeatureId: 'F139',
        ownerUserId: 'owner-1',
        requesterCatId: 'codex61-sol',
        originRef: { kind: 'message', threadId: coordinate.threadId, messageId: 'origin' },
        approvalCardRef: { ...coordinate },
        createdAt: 1000,
      },
    },
    ...(status === 'approved'
      ? {
          approvedAt: 2000,
          approvedBy: 'owner-1',
          effectCheckpoint: { kind: 'create', taskId: 'private-schedule', appliedAt: 1900 },
        }
      : {}),
    ...(status === 'rejected' ? { rejectedAt: 2000, rejectedBy: 'owner-1' } : {}),
  };
}
export function scheduleItem(proposal = scheduleProposal()): ApprovalHubItem {
  if (proposal.publication.state !== 'anchored') throw new Error('Anchored fixture expected');
  const mutation = proposal.mutation,
    task = mutation.kind === 'create' ? mutation.task : mutation.taskSnapshot;
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F139',
    requesterCatId: proposal.requesterCatId,
    ownerUserId: proposal.ownerUserId,
    createdAt: proposal.createdAt,
    inlineApprovable: proposal.status !== 'applying',
    resolution: proposal.status === 'applying' ? 'accepted' : 'open',
    materialization: { state: proposal.status === 'applying' ? 'outcome_unknown' : 'not_started' },
    decisionMode: proposal.status === 'applying' ? undefined : 'approve-reject',
    summary: `${mutation.kind === 'create' ? 'Create' : 'Delete'} schedule: ${task.display.label}`,
    detail: {
      mutationKind: mutation.kind,
      taskId: task.id,
      trigger: task.trigger,
      deliveryThreadId: task.deliveryThreadId,
      ...(mutation.kind === 'create'
        ? { templateId: task.templateId }
        : { expectedFingerprint: mutation.expectedFingerprint }),
    },
    navigation: { state: 'anchored', originRef: proposal.publication.envelope.originRef, approvalCardRef: coordinate },
  };
}
export const scheduleBlock: RichCardBlock = {
  id: 'schedule-mutation-schedule-1',
  kind: 'card',
  v: 1,
  title: 'Untrusted published title',
  meta: { approval: { producerId: 'F139', canonicalProposalId: 'schedule-1' } },
  actions: [
    { action: 'schedule:approve', label: '批准并创建', payload: { proposalId: 'schedule-1' } },
    { action: 'schedule:reject', label: '驳回', payload: { proposalId: 'schedule-1' } },
  ],
};
export const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => structuredClone(body) }) as Response;
