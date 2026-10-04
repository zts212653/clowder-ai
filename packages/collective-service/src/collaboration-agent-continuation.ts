import type {
  CollectiveCollaborationActor,
  CollectiveContinueWorkRequest,
  CollectiveEventEnvelope,
  CollectiveWorkRecord,
} from '@cat-cafe/shared';
import { advanceWork, mutableWork, requireWorkSource } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork, requireWorkRevision } from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { requireParticipant, sourceAuthorizesParticipant } from './participation-store.js';
import type { MutableServiceState } from './state.js';
import { requireRegisteredWorkGrant } from './work-policy-store.js';

/** A Cat recognizes the matter; the Service atomically checks current scope and versions its execution authority. */
export function continueCollectiveWorkAsAgent(
  state: MutableServiceState,
  credential: string,
  input: CollectiveContinueWorkRequest,
  now: number,
) {
  const connection = requireConnection(state, credential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  const human = requireAuthorizedHuman(state, connection);
  const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const participant = requireParticipant(state, {
    ...input,
    humanId: human.humanId,
    channelId: source.location.channelId,
  });
  if (!sourceAuthorizesParticipant(source, { ...input, humanId: human.humanId }))
    throw new CollectiveServiceError('PARTICIPATION_REVOKED', 'The exact source does not authorize this Cat', 403);
  requireRegisteredWorkGrant(state, input, source, now);
  const actorScope = `connection:${connection.connectionId}:cat:${participant.catId}`;
  const replay = collaborationOperationReplay(state, { ...input, actorScope, payload: input, resourceKind: 'work' });
  if (replay.existing)
    return projectCollectiveWork(
      state,
      requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
      now,
    );
  const work = mutableWork(state, input.collectiveId, input.workId);
  const consumed = (state.events[input.collectiveId] ?? []).some((event) => {
    const notice = event.workExecutionNotice;
    return (
      notice?.workId === work.workId &&
      notice.sourceEventId === input.sourceEventId &&
      notice.grantRef === input.grantRef &&
      notice.grantRevision === input.grantRevision
    );
  });
  if (consumed)
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'This source and permission already authorized its continuation; recover the original operation',
      409,
    );
  requireWorkRevision(work, input.expectedRevision);
  const assignmentEventId = requireCurrentMatter(state, work, input, source, human.humanId);
  const authorityRevision = (work.executionAuthority?.revision ?? 1) + 1;
  const resultRevision = (work.resultRevision ?? (work.resultEventId ? 1 : 0)) + 1;
  const actor: CollectiveCollaborationActor = {
    kind: 'agent',
    humanId: human.humanId,
    humanDisplayName: human.displayName,
    connectionId: connection.connectionId,
    catId: participant.catId,
    displayName: participant.displayName,
  };
  const eventActor: CollectiveEventEnvelope['actor'] = {
    kind: 'agent',
    human: { humanId: human.humanId, displayName: human.displayName },
    agent: { agentId: participant.catId, displayName: participant.displayName },
    provenance: {
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
      endpointLabel: connection.endpointLabel,
      catId: participant.catId,
      sessionRef: input.sessionRef,
    },
  };
  const notice = {
    v: 1 as const,
    workId: work.workId,
    sourceEventId: source.eventId,
    operationRef: input.requestId,
    grantRef: input.grantRef,
    grantRevision: input.grantRevision,
    requestKind: input.requestKind,
    revision: authorityRevision,
    assignmentEventId,
    participationRevision: input.participationRevision,
    resultRevision,
  };
  const event = appendEvent(state, {
    coordinates: {
      ...input,
      clientEventId: `work-continue:${work.workId}:${input.requestId}`,
      target: { kind: 'agent', humanId: human.humanId, agentId: participant.catId },
      location: {
        channelId: work.sourceLocation.channelId,
        rootEventId: work.sourceLocation.rootEventId ?? work.sourceEventId,
      },
      recipient: {
        kind: 'agent',
        humanId: human.humanId,
        connectionId: connection.connectionId,
        agentId: participant.catId,
        participationRevision: input.participationRevision,
      },
      replyToEventId: source.eventId,
      workRequest: 'continue',
      workExecutionNotice: notice,
      body: `我继续这件工作：${source.body}`,
    },
    actorScope,
    actor: eventActor,
    now,
  });
  work.executionAuthority = { ...notice, eventId: event.eventId };
  work.lifecycle = 'in_progress';
  const at = new Date(now).toISOString();
  advanceWork(work, 'execution_authorized', actor, at, event.eventId, source.eventId, resultRevision);
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: work.workId,
    revision: work.revision,
    recordedAt: at,
  });
  return projectCollectiveWork(state, work, now);
}

function requireCurrentMatter(
  state: MutableServiceState,
  work: CollectiveWorkRecord,
  input: CollectiveContinueWorkRequest,
  source: CollectiveEventEnvelope & { location: NonNullable<CollectiveEventEnvelope['location']> },
  humanId: string,
) {
  if (
    !work.assignment ||
    !work.assignmentEventId ||
    work.assignment.connectionId !== input.connectionId ||
    work.assignment.catId !== input.catId ||
    work.assignment.humanId !== humanId ||
    work.accountableHumanId !== humanId ||
    work.sourceLocation.channelId !== source.location.channelId ||
    !['committed', 'in_progress', 'result_ready'].includes(work.lifecycle)
  )
    throw new CollectiveServiceError(
      'WORK_AUTHORITY_REQUIRED',
      'Continue the current matter assigned to this exact Café and Cat',
      403,
    );
  const referenced = source.replyToEventId;
  const candidates = referenced
    ? Object.values(state.works).filter(
        (candidate) => candidate.collectiveId === input.collectiveId && workReferences(candidate, referenced),
      )
    : [];
  if (candidates.length > 1 || (candidates.length === 1 && candidates[0]?.workId !== work.workId))
    throw new CollectiveServiceError(
      'WORK_SOURCE_AMBIGUOUS',
      'The exact source belongs to another or ambiguous matter',
      409,
    );
  if (
    referenced &&
    work.history.some((entry) => entry.action === 'result_returned' && entry.eventId === referenced) &&
    referenced !== work.resultEventId
  )
    throw new CollectiveServiceError('WORK_RESULT_NOT_CURRENT', 'Feedback references an older result', 409);
  if (
    input.kind === 'revision' &&
    (!work.resultEventId ||
      work.lifecycle !== 'result_ready' ||
      input.resultEventId !== work.resultEventId ||
      input.resultRevision !== (work.resultRevision ?? 1))
  )
    throw new CollectiveServiceError('WORK_RESULT_NOT_CURRENT', 'Revise the exact current result', 409);
  if (input.kind === 'resume' && work.lifecycle === 'result_ready')
    throw new CollectiveServiceError(
      'WORK_RESULT_NOT_CURRENT',
      'Returned results require an exact result revision',
      409,
    );
  return work.assignmentEventId;
}

export function workReferences(work: CollectiveWorkRecord, eventId: string) {
  return [
    work.sourceEventId,
    work.assignmentEventId,
    work.resultEventId,
    work.executionAuthority?.eventId,
    work.executionAuthority?.sourceEventId,
    ...work.history.flatMap((entry) => [
      entry.eventId,
      ...(entry.action === 'execution_authorized' ? [entry.note] : []),
    ]),
  ].includes(eventId);
}
