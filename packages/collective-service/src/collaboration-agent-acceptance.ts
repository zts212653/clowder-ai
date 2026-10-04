import type {
  CollectiveAcceptWorkRequest,
  CollectiveCollaborationActor,
  CollectiveEventEnvelope,
} from '@cat-cafe/shared';
import { createWorkProposal, mutableWork, requireWorkSource } from './collaboration-command-helpers.js';
import { commitCollectiveWorkAssignment } from './collaboration-commit.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork } from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireParticipant, sourceAuthorizesParticipant } from './participation-store.js';
import type { MutableServiceState } from './state.js';
import { requireRegisteredWorkGrant } from './work-policy-store.js';

/** All source, permission, operation and assignment checks share the Service transaction. */
export function acceptCollectiveWorkAsAgent(
  state: MutableServiceState,
  credential: string,
  input: CollectiveAcceptWorkRequest,
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
    throw new CollectiveServiceError('PARTICIPATION_REVOKED', 'The source does not authorize this exact Cat', 403);
  requireRegisteredWorkGrant(state, input, source, now);
  const actorScope = `connection:${connection.connectionId}:cat:${participant.catId}`;
  const replay = collaborationOperationReplay(state, { ...input, actorScope, payload: input, resourceKind: 'work' });
  if (replay.existing)
    return projectCollectiveWork(
      state,
      requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
      now,
    );
  const related = Object.values(state.works).filter(
    (work) =>
      work.collectiveId === input.collectiveId &&
      [source.eventId, source.replyToEventId].some(
        (eventId) => eventId && [work.sourceEventId, work.assignmentEventId, work.resultEventId].includes(eventId),
      ),
  );
  const proposed =
    related.length === 1 && related[0]?.lifecycle === 'proposed' && related[0].sourceEventId === source.eventId
      ? related[0]
      : undefined;
  if (related.length && !proposed)
    throw new CollectiveServiceError(
      related.length > 1 ? 'WORK_SOURCE_AMBIGUOUS' : 'WORK_CONTINUATION_REQUIRED',
      'This exact source belongs to existing work; continue the matter instead of accepting another Work',
      409,
    );
  if (proposed && proposed.intendedOutcome !== input.intendedOutcome)
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'Accept the exact proposed outcome before changing this matter',
      409,
    );
  const actor: CollectiveCollaborationActor = {
    kind: 'agent',
    humanId: human.humanId,
    humanDisplayName: human.displayName,
    connectionId: connection.connectionId,
    catId: participant.catId,
    displayName: participant.displayName,
  };
  const proposal = proposed ?? createWorkProposal(state, input, actor, actorScope, now);
  const work = mutableWork(state, input.collectiveId, proposal.workId);
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
  work.acceptance = {
    v: 1,
    workId: work.workId,
    sourceEventId: source.eventId,
    operationRef: input.requestId,
    grantRef: input.grantRef,
    grantRevision: input.grantRevision,
    requestKind: input.requestKind,
  };
  commitCollectiveWorkAssignment(
    state,
    {
      ...input,
      assignment: {
        connectionId: connection.connectionId,
        catId: participant.catId,
        participationRevision: input.participationRevision,
      },
    },
    work,
    human,
    actorScope,
    actor,
    eventActor,
    now,
    work.acceptance,
  );
  if (!work.assignmentEventId)
    throw new CollectiveServiceError('STATE_CORRUPT', 'Accepted Work has no assignment', 409);
  work.executionAuthority = {
    ...work.acceptance,
    revision: 1,
    assignmentEventId: work.assignmentEventId,
    eventId: work.assignmentEventId,
    participationRevision: input.participationRevision,
    resultRevision: 1,
  };
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: work.workId,
    revision: work.revision,
    recordedAt: new Date(now).toISOString(),
  });
  return projectCollectiveWork(state, work, now);
}
