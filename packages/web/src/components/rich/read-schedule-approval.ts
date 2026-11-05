import type {
  ApprovalHubItem,
  RichCardBlock,
  ScheduleMutationProposal,
  ScheduleMutationTaskDefinition,
} from '@cat-cafe/shared';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { readFreshApprovalResultOwner } from '@/lib/approval-result-owner';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';

import {
  parseScheduleProposal,
  scheduleObject,
  scheduleText as text,
  scheduleTime as time,
} from './parse-schedule-proposal';

export { parseScheduleProposal, scheduleObject } from './parse-schedule-proposal';
export type ScheduleCoordinate = { threadId: string; messageId: string };

/** Recognition of the canonical recovery projection only. The original owner GET must still prove applying before any resume. */
export function isScheduleRecoveryProjection(
  item: Pick<
    ApprovalHubItem,
    'sourceFeatureId' | 'resolution' | 'materialization' | 'inlineApprovable' | 'decisionMode'
  >,
): boolean {
  return (
    item.sourceFeatureId === 'F139' &&
    item.resolution === 'accepted' &&
    item.materialization.state === 'outcome_unknown' &&
    !item.inlineApprovable &&
    item.decisionMode === undefined
  );
}

export function isScheduleMutationProposalCardBlock(block: RichCardBlock): boolean {
  return (
    block.id.startsWith('schedule-mutation-') ||
    (scheduleObject(block.meta?.approval) && block.meta.approval.producerId === 'F139') ||
    Boolean(block.actions?.some((a) => a.action.startsWith('schedule:')))
  );
}
export function schedulePublicationCandidate(block: RichCardBlock): string | null {
  const prefix = 'schedule-mutation-',
    id = block.id.startsWith(prefix) ? block.id.slice(prefix.length) : '';
  if (!id || block.actions?.length !== 2) return null;
  for (const name of ['schedule:approve', 'schedule:reject']) {
    const matches = block.actions.filter((a) => a.action === name);
    if (
      matches.length !== 1 ||
      !scheduleObject(matches[0].payload) ||
      Object.keys(matches[0].payload).length !== 1 ||
      matches[0].payload.proposalId !== id
    )
      return null;
  }
  const stamp = block.meta?.approval;
  if (
    stamp !== undefined &&
    (!scheduleObject(stamp) ||
      Object.keys(stamp).length !== 2 ||
      stamp.producerId !== 'F139' ||
      stamp.canonicalProposalId !== id)
  )
    return null;
  return id;
}
export function scheduleTask(p: ScheduleMutationProposal): ScheduleMutationTaskDefinition {
  return p.mutation.kind === 'create' ? p.mutation.task : p.mutation.taskSnapshot;
}
export function scheduleDetail(p: ScheduleMutationProposal): Record<string, unknown> {
  const task = scheduleTask(p);
  return {
    mutationKind: p.mutation.kind,
    taskId: task.id,
    trigger: task.trigger,
    deliveryThreadId: task.deliveryThreadId,
    ...(p.mutation.kind === 'create'
      ? { templateId: task.templateId }
      : { expectedFingerprint: p.mutation.expectedFingerprint }),
  };
}
function matchesItem(p: ScheduleMutationProposal, item: ApprovalHubItem): boolean {
  if (p.publication.state !== 'anchored' || item.navigation.state !== 'anchored') return false;
  const ref = p.publication.envelope.approvalCardRef;
  return (
    item.sourceFeatureId === 'F139' &&
    item.proposalId === p.proposalId &&
    item.ownerUserId === p.ownerUserId &&
    item.requesterCatId === p.requesterCatId &&
    item.createdAt === p.createdAt &&
    item.navigation.approvalCardRef.threadId === ref.threadId &&
    item.navigation.approvalCardRef.messageId === ref.messageId &&
    sameScheduleValue(p.publication.envelope.originRef, item.navigation.originRef) &&
    sameScheduleValue(scheduleDetail(p), item.detail)
  );
}

/** JSON object field order is not a version change; every actual field/value still must match. */
export function sameScheduleValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameScheduleValue(v, b[i]));
  if (!scheduleObject(a) || !scheduleObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameScheduleValue(a[k], b[k]))
  );
}

export async function readScheduleProposal(proposalId: string): Promise<ScheduleMutationProposal | null> {
  const response = await apiFetch(
    `/api/schedule-proposals/${encodeURIComponent(proposalId)}`,
    {},
    { afterCurrentGet: true },
  );
  const proposal = response.ok ? parseScheduleProposal(await response.json()) : null;
  return proposal?.proposalId === proposalId ? proposal : null;
}

/** Both entrances re-read the same private producer, publication and pending vector; terminal is never inferred from absence. */
export async function readScheduleSource(
  proposalId: string,
  coordinate: ScheduleCoordinate,
  item?: ApprovalHubItem,
  fresh = true,
): Promise<ScheduleMutationProposal | null> {
  const owner = { userId: await readFreshApprovalResultOwner() };
  if (!text(owner.userId) || (item && owner.userId !== item.ownerUserId)) return null;
  const proposal = await readScheduleProposal(proposalId);
  if (!proposal || proposal.ownerUserId !== owner.userId || proposal.publication.state !== 'anchored') return null;
  const ref = proposal.publication.envelope.approvalCardRef;
  if (
    ref.threadId !== coordinate.threadId ||
    ref.messageId !== coordinate.messageId ||
    (item && !matchesItem(proposal, item))
  )
    return null;
  if (proposal.status === 'approved' || proposal.status === 'rejected') return proposal;
  if (fresh) await useApprovalHubStore.getState().fetchPending();
  else await useApprovalHubStore.getState().ensurePending(owner.userId);
  const store = useApprovalHubStore.getState();
  if (!store.pendingReadAvailable || store.isLoading) return null;
  const body = { items: store.items };
  const copies = body.items.filter(
    (v) => scheduleObject(v) && v.sourceFeatureId === 'F139' && v.proposalId === proposalId,
  );
  if (copies.length !== 1) return null;
  const current = copies[0] as ApprovalHubItem;
  if (
    !matchesItem(proposal, current) ||
    (proposal.status === 'applying'
      ? !isScheduleRecoveryProjection(current)
      : current.resolution !== 'open' ||
        current.materialization.state !== 'not_started' ||
        !current.inlineApprovable ||
        current.decisionMode !== 'approve-reject')
  )
    return null;
  const match = matchHostedApproval({
    read: item ?? current,
    readOwnerUserId: owner.userId,
    storeItems: body.items,
    now: Date.now(),
  });
  return match.kind === 'matched' ? proposal : null;
}

/** An approved lifecycle alone does not prove registration/deletion; require its exact durable effect checkpoint. */
export function scheduleEffect(p: ScheduleMutationProposal): 'schedule-created' | 'schedule-deleted' | null {
  if (p.status !== 'approved' || !scheduleObject(p.effectCheckpoint)) return null;
  const checkpoint = p.effectCheckpoint;
  if (checkpoint.kind !== p.mutation.kind || checkpoint.taskId !== scheduleTask(p).id) return null;
  if (p.mutation.kind === 'create' && checkpoint.kind === 'create')
    return time(checkpoint.appliedAt) ? 'schedule-created' : null;
  if (p.mutation.kind !== 'delete' || checkpoint.kind !== 'delete') return null;
  return checkpoint.expectedFingerprint === p.mutation.expectedFingerprint && time(checkpoint.deletedAt)
    ? 'schedule-deleted'
    : null;
}
