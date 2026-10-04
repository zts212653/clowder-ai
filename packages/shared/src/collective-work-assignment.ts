import type { CollectiveWorkProjection } from './types/collective-collaboration.js';
import type { CollectiveSourceIdentity } from './types/collective-participation.js';
import {
  collectiveWorkAcceptanceNoticeSchema,
  collectiveWorkExecutionNoticeSchema,
} from './types/collective-work-acceptance.js';

/** Matches immutable assignment evidence against a freshly read Service Work. Never promotes arbitrary Agent text. */
export function collectiveWorkAssignmentMatches(
  source: CollectiveSourceIdentity,
  work: CollectiveWorkProjection,
  unsafeNotice?: unknown,
) {
  const assignment = work.assignment;
  if (
    !assignment ||
    source.serviceInstanceId !== work.serviceInstanceId ||
    source.collectiveId !== work.collectiveId ||
    source.connectionId !== assignment.connectionId ||
    source.eventId !== work.assignmentEventId ||
    source.catId !== assignment.catId ||
    source.participationRevision !== assignment.participationRevision ||
    source.location.channelId !== work.sourceLocation.channelId ||
    assignment.humanId !== work.accountableHumanId
  )
    return false;
  if (source.actor.kind === 'human') return !work.acceptance && source.actor.humanId === work.accountableHumanId;
  const notice = collectiveWorkAcceptanceNoticeSchema.safeParse(unsafeNotice);
  const acceptance = work.acceptance;
  return Boolean(
    notice.success &&
      acceptance &&
      notice.data.workId === work.workId &&
      notice.data.sourceEventId === work.sourceEventId &&
      notice.data.sourceEventId === acceptance.sourceEventId &&
      notice.data.operationRef === acceptance.operationRef &&
      notice.data.grantRef === acceptance.grantRef &&
      notice.data.grantRevision === acceptance.grantRevision &&
      notice.data.requestKind === acceptance.requestKind &&
      source.actor.human.humanId === work.accountableHumanId &&
      source.actor.provenance.connectionId === assignment.connectionId &&
      source.actor.provenance.catId === assignment.catId &&
      source.actor.agent.agentId === assignment.catId &&
      work.history.some(
        (entry) =>
          entry.action === 'committed' &&
          entry.eventId === source.eventId &&
          entry.actor.kind === 'agent' &&
          entry.actor.connectionId === assignment.connectionId &&
          entry.actor.catId === assignment.catId &&
          entry.actor.humanId === assignment.humanId,
      ),
  );
}

/** A fresh current execution source does not revive permission on the immutable birth source. */
export function collectiveWorkExecutionMatches(
  source: CollectiveSourceIdentity,
  work: CollectiveWorkProjection,
  unsafeNotice?: unknown,
) {
  const notice = collectiveWorkExecutionNoticeSchema.safeParse(unsafeNotice);
  const current = work.executionAuthority;
  const assignment = work.assignment;
  return Boolean(
    notice.success &&
      current &&
      assignment &&
      source.serviceInstanceId === work.serviceInstanceId &&
      source.collectiveId === work.collectiveId &&
      source.connectionId === assignment.connectionId &&
      source.catId === assignment.catId &&
      source.eventId === current.eventId &&
      source.participationRevision === current.participationRevision &&
      source.location.channelId === work.sourceLocation.channelId &&
      assignment.humanId === work.accountableHumanId &&
      source.actor.kind === 'agent' &&
      source.actor.human.humanId === assignment.humanId &&
      source.actor.provenance.connectionId === assignment.connectionId &&
      source.actor.provenance.catId === assignment.catId &&
      source.actor.agent.agentId === assignment.catId &&
      notice.data.workId === work.workId &&
      notice.data.assignmentEventId === work.assignmentEventId &&
      notice.data.revision === current.revision &&
      notice.data.sourceEventId === current.sourceEventId &&
      notice.data.operationRef === current.operationRef &&
      notice.data.grantRef === current.grantRef &&
      notice.data.grantRevision === current.grantRevision &&
      notice.data.requestKind === current.requestKind &&
      notice.data.participationRevision === current.participationRevision &&
      notice.data.resultRevision <= current.resultRevision &&
      work.history.some(
        (entry) =>
          entry.action === 'execution_authorized' &&
          entry.eventId === source.eventId &&
          entry.note === current.sourceEventId &&
          entry.resultRevision === notice.data.resultRevision &&
          entry.actor.kind === 'agent' &&
          entry.actor.connectionId === assignment.connectionId &&
          entry.actor.catId === assignment.catId &&
          entry.actor.humanId === assignment.humanId,
      ),
  );
}
