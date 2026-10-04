import type { AssignedWorkAuthorityScope, ConnectorInboxItem } from '@cat-cafe/collective-connector';
import type { CollectiveSourceIdentity } from '@cat-cafe/shared';

export function collectiveWorkContinuation(
  scope: AssignedWorkAuthorityScope,
  source: CollectiveSourceIdentity,
  sourceMessageId: string,
): { resultRevision: number; feedbackEventId?: string; feedbackText?: string } {
  const { connection, inbox, work } = scope;
  const assignment = work.assignment;
  const assignedSources = inbox.filter((item) => assignmentSourceMatches(item, connection.connectionId, source));
  if (
    connection.authorityStatus !== 'connected' ||
    !connection.authorizedHumanId ||
    work.serviceInstanceId !== source.serviceInstanceId ||
    work.collectiveId !== source.collectiveId ||
    (work.executionAuthority?.eventId ?? work.assignmentEventId) !== source.eventId ||
    work.sourceLocation.channelId !== source.location.channelId ||
    !assignment ||
    work.accountableHumanId !== connection.authorizedHumanId ||
    assignment.connectionId !== connection.connectionId ||
    assignment.humanId !== connection.authorizedHumanId ||
    assignment.catId !== source.catId ||
    (work.executionAuthority?.participationRevision ?? assignment.participationRevision) !==
      source.participationRevision ||
    assignedSources.length !== 1 ||
    assignedSources[0]?.routeReceipt?.kind !== 'thread_message' ||
    assignedSources[0].routeReceipt.messageId !== sourceMessageId
  ) {
    throw continuationUnavailable();
  }

  if (work.executionAuthority && work.executionAuthority.revision > 1)
    return currentExecutionContinuation(scope, source);

  if (
    !work.resultEventId &&
    work.resultRevision === undefined &&
    ['committed', 'in_progress'].includes(work.lifecycle) &&
    ['ready', 'in_progress'].includes(work.status)
  ) {
    return { resultRevision: 1 };
  }

  const resultRevision = work.resultRevision ?? 1;
  const pendingRevision = work.history.find(
    (entry) =>
      entry.action === 'revision_requested' &&
      entry.eventId === work.resultEventId &&
      (entry.resultRevision ?? 1) === resultRevision,
  );
  const feedback = pendingRevision?.note;
  if (work.lifecycle !== 'in_progress' || work.status !== 'in_progress' || !work.resultEventId || !feedback) {
    throw continuationUnavailable();
  }
  const notices = inbox
    .map((item) =>
      revisionContinuation(item, connection.connectionId, source, work, feedback, pendingRevision?.revision),
    )
    .filter((value) => value !== null);
  if (notices.length !== 1) throw continuationUnavailable();
  return notices[0];
}

function currentExecutionContinuation(scope: AssignedWorkAuthorityScope, source: CollectiveSourceIdentity) {
  const { work, inbox } = scope;
  const authority = work.executionAuthority;
  if (
    !authority ||
    work.lifecycle !== 'in_progress' ||
    work.status !== 'in_progress' ||
    authority.resultRevision !== (work.resultRevision ?? 0) + 1
  )
    throw continuationUnavailable();
  const feedbackSources = inbox.filter(
    (item) =>
      item.event.eventId === authority.sourceEventId &&
      item.event.serviceInstanceId === source.serviceInstanceId &&
      item.event.collectiveId === source.collectiveId &&
      item.event.location?.channelId === source.location.channelId,
  );
  return {
    resultRevision: authority.resultRevision,
    feedbackEventId: authority.sourceEventId,
    ...(feedbackSources.length === 1 ? { feedbackText: feedbackSources[0]?.event.body } : {}),
  };
}

function revisionContinuation(
  item: ConnectorInboxItem,
  connectionId: string,
  source: CollectiveSourceIdentity,
  work: AssignedWorkAuthorityScope['work'],
  feedback: string,
  feedbackWorkRevision?: number,
): { resultRevision: number; feedbackEventId: string; feedbackText: string } | null {
  const event = item.event;
  const notice = event.workRevisionNotice;
  const recipient = event.recipient;
  if (
    event.workRequest !== 'revise' ||
    event.actor.kind !== 'human' ||
    event.actor.humanId !== work.accountableHumanId ||
    !notice ||
    notice.workId !== work.workId ||
    notice.workRevision !== feedbackWorkRevision ||
    notice.assignmentEventId !== work.assignmentEventId ||
    notice.resultEventId !== work.resultEventId ||
    notice.resultRevision !== (work.resultRevision ?? 1) ||
    event.serviceInstanceId !== source.serviceInstanceId ||
    event.collectiveId !== source.collectiveId ||
    event.location?.channelId !== source.location.channelId ||
    event.replyToEventId !== notice.resultEventId ||
    event.body !== feedback ||
    event.target.kind !== 'agent' ||
    event.target.humanId !== work.accountableHumanId ||
    event.target.agentId !== source.catId ||
    recipient?.kind !== 'agent' ||
    recipient.connectionId !== connectionId ||
    recipient.humanId !== event.actor.humanId ||
    recipient.agentId !== source.catId ||
    recipient.participationRevision !== source.participationRevision
  ) {
    return null;
  }
  return { resultRevision: notice.resultRevision + 1, feedbackEventId: event.eventId, feedbackText: feedback };
}

function assignmentSourceMatches(item: ConnectorInboxItem, connectionId: string, source: CollectiveSourceIdentity) {
  const event = item.event;
  const recipient = event.recipient;
  return (
    event.eventId === source.eventId &&
    ['entrust', 'continue'].includes(String(event.workRequest)) &&
    event.serviceInstanceId === source.serviceInstanceId &&
    event.collectiveId === source.collectiveId &&
    event.location?.channelId === source.location.channelId &&
    recipient?.kind === 'agent' &&
    recipient.connectionId === connectionId &&
    recipient.agentId === source.catId &&
    recipient.participationRevision === source.participationRevision
  );
}

function continuationUnavailable() {
  return Object.assign(new Error('Collective Work has no current executable result round'), {
    code: 'COLLECTIVE_WORK_CONTINUATION_UNAVAILABLE',
  });
}
