import type {
  CollectiveRoadmapRecord,
  CollectiveWorkRecord,
  CreateCollectiveProjectRequest,
  CreateCollectiveProjectTaskRequest,
} from '@cat-cafe/shared';
import { appendAccountabilityRequest } from './collaboration-accountability.js';
import { humanActor, humanEventActor, requireRoadmap } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork } from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string; readonly avatarUrl?: string };

export function createCollectiveProjectFromPage(
  state: MutableServiceState,
  input: CreateCollectiveProjectRequest,
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
  const source = appendProjectPageSource(state, {
    ...input,
    actorScope,
    actor: humanEventActor(human),
    body: `新建项目「${input.title}」\n完成标准：${input.purpose}`,
    now,
  });
  const at = new Date(now).toISOString();
  const roadmapId = createStableId('roadmap_');
  const roadmap: CollectiveRoadmapRecord = {
    v: 1,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    roadmapId,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: input.title,
    purpose: input.purpose,
    accountableHumanId: human.humanId,
    workIds: [],
    status: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor: humanActor(human), at }],
  };
  state.roadmaps[roadmapId] = roadmap;
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'roadmap',
    resourceId: roadmapId,
    revision: roadmap.revision,
    recordedAt: at,
  });
  return structuredClone(roadmap);
}

export function createCollectiveProjectTask(
  state: MutableServiceState,
  input: CreateCollectiveProjectTaskRequest,
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
    return {
      roadmap: structuredClone(requireRoadmap(state, input.collectiveId, input.roadmapId)),
      work: projectCollectiveWork(
        state,
        requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
        now,
      ),
    };
  }
  const roadmap = requireProjectMutation(state, input, human.humanId);
  const source = appendProjectPageSource(state, {
    ...input,
    actorScope,
    actor: humanEventActor(human),
    body: `新建任务「${input.title}」\n完成标准：${input.intendedOutcome}`,
    now,
  });
  const at = new Date(now).toISOString();
  const workId = createStableId('work_');
  const work: CollectiveWorkRecord = {
    v: 1,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    workId,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    title: input.title,
    intendedOutcome: input.intendedOutcome,
    proposedBy: humanActor(human),
    ...(input.accountability === 'self' ? { accountableHumanId: human.humanId } : {}),
    accountabilityRequests: [],
    dependencyWorkIds: [],
    lifecycle: 'committed',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [
      {
        revision: 1,
        action: 'committed',
        actor: humanActor(human),
        at,
        eventId: source.eventId,
        note: '从项目页新建任务',
      },
    ],
  };
  state.works[workId] = work;
  roadmap.workIds = [...roadmap.workIds, workId];
  roadmap.revision += 1;
  roadmap.updatedAt = at;
  roadmap.history.push({
    revision: roadmap.revision,
    action: 'works_changed',
    actor: humanActor(human),
    at,
    note: `新增任务：${work.title}`,
  });
  if (input.requestedAccountableHumanId) {
    appendAccountabilityRequest(
      state,
      {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        requestId: `${input.requestId}:accountability`,
        roadmapId: roadmap.roadmapId,
        workId,
        expectedRevision: work.revision,
        targetHumanId: input.requestedAccountableHumanId,
      },
      human,
      now,
    );
  }
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: workId,
    revision: work.revision,
    recordedAt: at,
  });
  return { roadmap: structuredClone(roadmap), work: projectCollectiveWork(state, work, now) };
}

function requireProjectMutation(
  state: MutableServiceState,
  input: Pick<CreateCollectiveProjectTaskRequest, 'collectiveId' | 'roadmapId' | 'expectedRoadmapRevision'>,
  humanId: string,
) {
  const roadmap = state.roadmaps[input.roadmapId];
  if (!roadmap || roadmap.collectiveId !== input.collectiveId) {
    throw new CollectiveServiceError('ROADMAP_NOT_FOUND', 'Collective Project was not found', 404);
  }
  if (roadmap.accountableHumanId !== humanId) {
    throw new CollectiveServiceError('ROADMAP_AUTHORITY_REQUIRED', 'Only the Project owner can create its Tasks', 403);
  }
  if (roadmap.status !== 'active') {
    throw new CollectiveServiceError('ROADMAP_COMPLETED', 'Reopen this Project before creating a Task', 409);
  }
  if (roadmap.revision !== input.expectedRoadmapRevision) {
    throw new CollectiveServiceError(
      'ROADMAP_REVISION_CONFLICT',
      'Collective Project changed; refresh and try again',
      409,
    );
  }
  return roadmap;
}

function appendProjectPageSource(
  state: MutableServiceState,
  input: {
    readonly serviceInstanceId: string;
    readonly collectiveId: string;
    readonly requestId: string;
    readonly channelId: string;
    readonly actorScope: string;
    readonly actor: ReturnType<typeof humanEventActor>;
    readonly body: string;
    readonly now: number;
  },
) {
  const event = appendEvent(state, {
    coordinates: {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      clientEventId: `${input.requestId}:source`,
      location: { channelId: input.channelId },
      recipient: { kind: 'channel' },
      body: input.body,
    },
    actorScope: input.actorScope,
    actor: input.actor,
    now: input.now,
  });
  if (!event.location)
    throw new CollectiveServiceError('LOCATION_REQUIRED', 'Project source location was not proven', 409);
  return event as typeof event & { readonly location: NonNullable<typeof event.location> };
}
