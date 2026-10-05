import type {
  CreateCollectiveRoadmapRequest,
  SetCollectiveRoadmapStatusRequest,
  SetCollectiveRoadmapWorksRequest,
} from '@cat-cafe/shared';
import {
  humanActor,
  requireRoadmap,
  requireRoadmapWork,
  requireWorkSource,
  unique,
} from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string };

export function createCollectiveRoadmap(
  state: MutableServiceState,
  input: CreateCollectiveRoadmapRequest,
  human: Human,
  now: number,
) {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'roadmap',
  });
  if (replay.existing) return structuredClone(requireRoadmap(state, input.collectiveId, replay.existing.resourceId));
  const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const workIds = unique(input.workIds);
  for (const workId of workIds) requireRoadmapWork(state, input.collectiveId, workId);
  const at = new Date(now).toISOString();
  const roadmapId = createStableId('roadmap_');
  const actor = humanActor(human);
  const roadmap = {
    v: 1 as const,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    roadmapId,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: input.title,
    purpose: input.purpose,
    accountableHumanId: human.humanId,
    workIds,
    status: 'active' as const,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created' as const, actor, at }],
  };
  state.roadmaps[roadmapId] = roadmap;
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'roadmap',
    resourceId: roadmapId,
    revision: 1,
    recordedAt: at,
  });
  return structuredClone(roadmap);
}

export function setCollectiveRoadmapWorks(
  state: MutableServiceState,
  input: SetCollectiveRoadmapWorksRequest,
  human: Human,
  now: number,
) {
  return changeRoadmap(state, input, human, now, (roadmap, at) => {
    if (roadmap.status === 'completed') {
      throw new CollectiveServiceError('ROADMAP_COMPLETED', 'Reopen this Roadmap before changing its Work', 409);
    }
    const workIds = unique(input.workIds);
    for (const workId of workIds) requireRoadmapWork(state, input.collectiveId, workId);
    roadmap.workIds = workIds;
    roadmap.history.push({
      revision: roadmap.revision + 1,
      action: 'works_changed',
      actor: humanActor(human),
      at,
    });
  });
}

export function setCollectiveRoadmapStatus(
  state: MutableServiceState,
  input: SetCollectiveRoadmapStatusRequest,
  human: Human,
  now: number,
) {
  return changeRoadmap(state, input, human, now, (roadmap, at) => {
    if (roadmap.status === input.status) return;
    if (
      input.status === 'completed' &&
      roadmap.workIds.some((workId) => requireRoadmapWork(state, input.collectiveId, workId).lifecycle !== 'completed')
    ) {
      throw new CollectiveServiceError(
        'ROADMAP_WORK_INCOMPLETE',
        'Complete every Work on this Roadmap before closing it',
        409,
      );
    }
    roadmap.status = input.status;
    roadmap.history.push({
      revision: roadmap.revision + 1,
      action: input.status === 'completed' ? 'completed' : 'reopened',
      actor: humanActor(human),
      at,
      ...(input.note ? { note: input.note } : {}),
    });
  });
}

function changeRoadmap(
  state: MutableServiceState,
  input: SetCollectiveRoadmapWorksRequest | SetCollectiveRoadmapStatusRequest,
  human: Human,
  now: number,
  update: (roadmap: MutableServiceState['roadmaps'][string], at: string) => void,
) {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'roadmap',
  });
  if (replay.existing) return structuredClone(requireRoadmap(state, input.collectiveId, replay.existing.resourceId));
  const roadmap = state.roadmaps[input.roadmapId];
  if (!roadmap || roadmap.collectiveId !== input.collectiveId) {
    throw new CollectiveServiceError('ROADMAP_NOT_FOUND', 'Collective Roadmap was not found', 404);
  }
  if (roadmap.accountableHumanId !== human.humanId) {
    throw new CollectiveServiceError(
      'ROADMAP_AUTHORITY_REQUIRED',
      'Only the accountable Human can change this Roadmap',
      403,
    );
  }
  if (roadmap.revision !== input.expectedRevision) {
    throw new CollectiveServiceError(
      'ROADMAP_REVISION_CONFLICT',
      'Collective Roadmap changed; refresh and try again',
      409,
    );
  }
  const at = new Date(now).toISOString();
  const before = roadmap.history.length;
  update(roadmap, at);
  if (roadmap.history.length !== before) {
    roadmap.revision += 1;
    roadmap.updatedAt = at;
  }
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'roadmap',
    resourceId: roadmap.roadmapId,
    revision: roadmap.revision,
    recordedAt: at,
  });
  return structuredClone(roadmap);
}
