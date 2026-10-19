import type {
  RequestCollectiveWorkAccountabilityRequest,
  RespondCollectiveWorkAccountabilityRequest,
} from '@cat-cafe/shared';
import { requireOperableAccountabilityRequest } from './collaboration-accountability-attention.js';
import {
  advanceWork,
  humanActor,
  humanEventActor,
  mutableWork,
  requireRoadmap,
} from './collaboration-command-helpers.js';
import { commitCollectiveWorkAssignment } from './collaboration-commit.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork, requireWorkRevision } from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { requireMembership } from './identity-store.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string; readonly avatarUrl?: string };

export function requestCollectiveWorkAccountability(
  state: MutableServiceState,
  input: RequestCollectiveWorkAccountabilityRequest,
  human: Human,
  now: number,
) {
  const actorScope = `human:${human.humanId}`;
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
  const work = appendAccountabilityRequest(state, input, human, now);
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

export function appendAccountabilityRequest(
  state: MutableServiceState,
  input: RequestCollectiveWorkAccountabilityRequest,
  human: Human,
  now: number,
) {
  const work = mutableWork(state, input.collectiveId, input.workId);
  requireWorkRevision(work, input.expectedRevision);
  const roadmap = requireRoadmap(state, input.collectiveId, input.roadmapId);
  if (!roadmap.workIds.includes(work.workId)) {
    throw new CollectiveServiceError('ROADMAP_WORK_REQUIRED', 'The requested Task is not part of this Project', 409);
  }
  if (roadmap.status !== 'active' || work.lifecycle !== 'committed' || work.assignment) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_UNAVAILABLE',
      'Only an active, not-yet-started Task can request another accountable Human',
      409,
    );
  }
  const controlsAccountability = work.accountableHumanId
    ? work.accountableHumanId === human.humanId
    : roadmap.accountableHumanId === human.humanId;
  if (!controlsAccountability) {
    throw new CollectiveServiceError(
      'WORK_AUTHORITY_REQUIRED',
      'Only the current Task owner, or the Project owner for an unassigned Task, can request responsibility',
      403,
    );
  }
  if (input.targetHumanId === human.humanId) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_TARGET_INVALID',
      'Use the direct responsibility action to take this Task yourself',
      409,
    );
  }
  const requests = work.accountabilityRequests ?? [];
  work.accountabilityRequests = requests;
  if (requests.some((request) => request.status === 'pending')) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_PENDING',
      'This Task already has a pending responsibility request',
      409,
    );
  }
  requireMembership(state, input.collectiveId, input.targetHumanId);
  const target = state.humans[input.targetHumanId];
  if (!target) throw new CollectiveServiceError('STATE_CORRUPT', 'Accountability target identity is missing', 409);
  const at = new Date(now).toISOString();
  const event = appendEvent(state, {
    coordinates: {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      clientEventId: `${input.requestId}:request`,
      location: work.sourceLocation,
      recipient: { kind: 'human', humanId: target.humanId },
      replyToEventId: work.sourceEventId,
      body: `${human.displayName} 邀请你负责：${work.title}`,
    },
    actorScope: `human:${human.humanId}`,
    actor: humanEventActor(human),
    now,
  });
  const accountabilityRequestId = createStableId('accountability_');
  requests.push({
    accountabilityRequestId,
    roadmapId: roadmap.roadmapId,
    targetHumanId: target.humanId,
    targetDisplayName: target.displayName,
    requestedByHumanId: human.humanId,
    requestedByDisplayName: human.displayName,
    requestEventId: event.eventId,
    requestedAt: at,
    status: 'pending',
  });
  advanceWork(
    work,
    'accountability_requested',
    humanActor(human),
    at,
    event.eventId,
    `邀请 ${target.displayName} 负责`,
  );
  return work;
}

export function respondCollectiveWorkAccountability(
  state: MutableServiceState,
  input: RespondCollectiveWorkAccountabilityRequest,
  human: Human,
  now: number,
) {
  const actorScope = `human:${human.humanId}`;
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
  const work = mutableWork(state, input.collectiveId, input.workId);
  requireWorkRevision(work, input.expectedRevision);
  const request = work.accountabilityRequests?.find(
    (candidate) => candidate.accountabilityRequestId === input.accountabilityRequestId,
  );
  if (!request) {
    throw new CollectiveServiceError('ACCOUNTABILITY_REQUEST_NOT_FOUND', 'Responsibility request was not found', 404);
  }
  if (request.targetHumanId !== human.humanId) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_TARGET_REQUIRED',
      'Only the named Human can respond to this responsibility request',
      403,
    );
  }
  if (request.status !== 'pending') {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_RESOLVED',
      'Responsibility request is already resolved',
      409,
    );
  }
  requireOperableAccountabilityRequest(state, work, request, human.humanId);
  const at = new Date(now).toISOString();
  const response = appendEvent(state, {
    coordinates: {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      clientEventId: `${input.requestId}:response`,
      location: work.sourceLocation,
      recipient: { kind: 'channel' },
      replyToEventId: work.sourceEventId,
      body: input.decision === 'accept' ? `我接下了：${work.title}` : `我暂不负责：${work.title}`,
    },
    actorScope,
    actor: humanEventActor(human),
    now,
  });
  request.status = input.decision === 'accept' ? 'accepted' : 'declined';
  request.responseEventId = response.eventId;
  request.respondedAt = at;
  if (input.decision === 'accept') {
    commitCollectiveWorkAssignment(
      state,
      {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        ...(input.assignment ? { assignment: input.assignment } : {}),
      },
      work,
      human,
      actorScope,
      humanActor(human),
      humanEventActor(human),
      now,
      undefined,
      'accountability_request_accepted',
      response.eventId,
      true,
    );
  } else {
    advanceWork(
      work,
      'accountability_request_declined',
      humanActor(human),
      at,
      response.eventId,
      '受邀成员暂未接受负责',
    );
  }
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
