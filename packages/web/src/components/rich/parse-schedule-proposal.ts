import type { ScheduleMutationProposal, ScheduleMutationTaskDefinition } from '@cat-cafe/shared';
export const scheduleObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
export const scheduleText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const scheduleTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function taskReadable(v: unknown): v is ScheduleMutationTaskDefinition {
  if (
    !scheduleObject(v) ||
    !scheduleText(v.id) ||
    !scheduleText(v.templateId) ||
    !scheduleObject(v.params) ||
    !scheduleObject(v.display) ||
    !scheduleText(v.display.label) ||
    !scheduleObject(v.trigger)
  )
    return false;
  if (
    !['pr', 'repo', 'thread', 'system', 'external', 'issue'].includes(String(v.display.category)) ||
    (v.display.description !== undefined && typeof v.display.description !== 'string') ||
    (v.deliveryThreadId !== null && !scheduleText(v.deliveryThreadId)) ||
    typeof v.enabled !== 'boolean' ||
    !scheduleText(v.createdBy) ||
    !scheduleText(v.createdAt)
  )
    return false;
  const trigger = v.trigger;
  return trigger.type === 'once'
    ? scheduleTime(trigger.fireAt)
    : trigger.type === 'interval'
      ? scheduleTime(trigger.ms) && trigger.ms > 0
      : trigger.type === 'cron' &&
        scheduleText(trigger.expression) &&
        (trigger.timezone === undefined || scheduleText(trigger.timezone));
}

/** Validate the full original owner GET before using its content or lifecycle. No persisted UI fields grant authority. */
export function parseScheduleProposal(body: unknown): ScheduleMutationProposal | null {
  const p = scheduleObject(body) ? body.proposal : null;
  if (
    !scheduleObject(p) ||
    !scheduleText(p.proposalId) ||
    !scheduleText(p.ownerUserId) ||
    !scheduleText(p.requesterCatId) ||
    !scheduleTime(p.createdAt) ||
    !['pending', 'applying', 'approved', 'rejected'].includes(String(p.status)) ||
    !scheduleObject(p.mutation) ||
    !scheduleObject(p.publication) ||
    p.publication.state !== 'anchored' ||
    !scheduleObject(p.publication.envelope)
  )
    return null;
  const mutation = p.mutation,
    envelope = p.publication.envelope;
  if (mutation.kind === 'create') {
    if (
      !taskReadable(mutation.task) ||
      (mutation.relativeOnceDelayMs !== undefined &&
        (!scheduleTime(mutation.relativeOnceDelayMs) || mutation.task.trigger.type !== 'once'))
    )
      return null;
  } else if (
    mutation.kind !== 'delete' ||
    !taskReadable(mutation.taskSnapshot) ||
    mutation.taskId !== mutation.taskSnapshot.id ||
    !scheduleText(mutation.expectedFingerprint)
  )
    return null;
  if (
    envelope.canonicalProposalId !== p.proposalId ||
    envelope.sourceFeatureId !== 'F139' ||
    envelope.ownerUserId !== p.ownerUserId ||
    envelope.requesterCatId !== p.requesterCatId ||
    envelope.createdAt !== p.createdAt ||
    !scheduleObject(envelope.approvalCardRef) ||
    !scheduleText(envelope.approvalCardRef.threadId) ||
    !scheduleText(envelope.approvalCardRef.messageId) ||
    !scheduleObject(envelope.originRef)
  )
    return null;
  if (p.status === 'approved' && (!scheduleTime(p.approvedAt) || !scheduleText(p.approvedBy))) return null;
  if (p.status === 'rejected' && (!scheduleTime(p.rejectedAt) || !scheduleText(p.rejectedBy))) return null;
  return p as unknown as ScheduleMutationProposal;
}
