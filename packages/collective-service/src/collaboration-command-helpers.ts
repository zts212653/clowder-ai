import type { CollectiveCollaborationActor, CollectiveEventEnvelope, CollectiveWorkRecord } from '@cat-cafe/shared';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork } from './collaboration-work.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState, ServiceState } from './state.js';

export function createWorkProposal(
  state: MutableServiceState,
  input: {
    serviceInstanceId: string;
    collectiveId: string;
    requestId: string;
    sourceEventId: string;
    title?: string;
    intendedOutcome?: string;
    requestKind?: string;
  },
  actor: CollectiveCollaborationActor,
  actorScope: string,
  now: number,
) {
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'work',
  });
  if (replay.existing) {
    return projectCollectiveWork(
      state,
      requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
      now,
    );
  }
  // The same source/real Cat remains the same proposal across invocation retries.
  const previous =
    actor.kind === 'agent'
      ? Object.values(state.works).find(
          (work) =>
            work.collectiveId === input.collectiveId &&
            work.sourceEventId === input.sourceEventId &&
            work.proposedBy.kind === 'agent' &&
            work.proposedBy.connectionId === actor.connectionId &&
            work.proposedBy.catId === actor.catId,
        )
      : undefined;
  if (previous) {
    if (
      (input.title && input.title !== previous.title) ||
      (input.intendedOutcome && input.intendedOutcome !== previous.intendedOutcome) ||
      (input.requestKind && input.requestKind !== previous.proposedRequestKind)
    )
      throw new CollectiveServiceError(
        'COLLABORATION_OPERATION_CONFLICT',
        'This source already identifies another proposal payload',
        409,
      );
    recordCollaborationOperation(state, {
      ...replay,
      actorScope,
      resourceKind: 'work',
      resourceId: previous.workId,
      revision: previous.revision,
      recordedAt: new Date(now).toISOString(),
    });
    return projectCollectiveWork(state, previous, now);
  }
  const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const at = new Date(now).toISOString();
  const workId = createStableId('work_');
  const work: CollectiveWorkRecord = {
    v: 1,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    workId,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: input.title ?? source.body.slice(0, 200),
    intendedOutcome: input.intendedOutcome ?? source.body,
    proposedBy: actor,
    ...(input.requestKind ? { proposedRequestKind: input.requestKind } : {}),
    dependencyWorkIds: [],
    lifecycle: 'proposed',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'proposed', actor, at, eventId: source.eventId }],
  };
  state.works[workId] = work;
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: workId,
    revision: 1,
    recordedAt: at,
  });
  return projectCollectiveWork(state, work, now);
}

export function requireHumanCommand(
  state: ServiceState,
  sessionToken: string,
  input: { serviceInstanceId: string; collectiveId: string },
) {
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const { human } = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  requireMembership(state, input.collectiveId, human.humanId);
  return human;
}

export function requireWorkSource(state: ServiceState, collectiveId: string, eventId: string) {
  const source = state.events[collectiveId]?.find((event) => event.eventId === eventId);
  if (!source?.location) {
    throw new CollectiveServiceError('WORK_SOURCE_UNAVAILABLE', 'Work must retain an exact public Channel source', 409);
  }
  return source as CollectiveEventEnvelope & { location: NonNullable<CollectiveEventEnvelope['location']> };
}

export function mutableWork(state: MutableServiceState, collectiveId: string, workId: string) {
  requireCollectiveWork(state, collectiveId, workId);
  const work = state.works[workId];
  if (!work) throw new CollectiveServiceError('WORK_NOT_FOUND', 'Collective Work was not found', 404);
  return work;
}

export function requireRoadmap(state: ServiceState, collectiveId: string, roadmapId: string) {
  const roadmap = state.roadmaps[roadmapId];
  if (!roadmap || roadmap.collectiveId !== collectiveId) {
    throw new CollectiveServiceError('ROADMAP_NOT_FOUND', 'Collective Roadmap was not found', 404);
  }
  return roadmap;
}

export function requireRoadmapWork(state: ServiceState, collectiveId: string, workId: string) {
  const work = requireCollectiveWork(state, collectiveId, workId);
  if (work.lifecycle === 'proposed' || work.lifecycle === 'declined' || work.lifecycle === 'cancelled') {
    throw new CollectiveServiceError('WORK_NOT_COMMITTED', 'Roadmap can contain only committed Work', 409);
  }
  return work;
}

export function humanActor(human: { humanId: string; displayName: string }): CollectiveCollaborationActor {
  return { kind: 'human', humanId: human.humanId, displayName: human.displayName };
}

export function humanEventActor(human: { humanId: string; displayName: string; avatarUrl?: string }) {
  return {
    kind: 'human' as const,
    humanId: human.humanId,
    displayName: human.displayName,
    ...(human.avatarUrl ? { avatarUrl: human.avatarUrl } : {}),
  };
}

export function advanceWork(
  work: MutableServiceState['works'][string],
  action:
    | 'committed'
    | 'dependencies_changed'
    | 'revision_requested'
    | 'result_accepted'
    | 'completed'
    | 'declined'
    | 'execution_authorized',
  actor: CollectiveCollaborationActor,
  at: string,
  eventId?: string,
  note?: string,
  resultRevision?: number,
) {
  work.revision += 1;
  work.updatedAt = at;
  work.history.push({
    revision: work.revision,
    action,
    actor,
    at,
    ...(eventId ? { eventId } : {}),
    ...(resultRevision ? { resultRevision } : {}),
    ...(note ? { note } : {}),
  });
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function byCreation(left: { createdAt: string }, right: { createdAt: string }) {
  return left.createdAt.localeCompare(right.createdAt);
}
