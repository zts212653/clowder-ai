import type { RequestCollectiveWorkRevisionRequest } from '@cat-cafe/shared';
import { advanceWork, humanActor, humanEventActor, mutableWork } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  projectCollectiveWork,
  requireCollectiveWork,
  requireWorkAccountableHuman,
  requireWorkRevision,
} from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import type { MutableServiceState } from './state.js';

export function requestCollectiveWorkRevision(
  state: MutableServiceState,
  input: RequestCollectiveWorkRevisionRequest,
  human: { humanId: string; displayName: string; avatarUrl?: string },
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
  requireWorkAccountableHuman(work, human.humanId);
  const resultRevision = work.resultEventId ? (work.resultRevision ?? 1) : undefined;
  if (
    work.lifecycle !== 'result_ready' ||
    !work.assignment ||
    !work.assignmentEventId ||
    work.resultEventId !== input.resultEventId ||
    resultRevision !== input.resultRevision
  ) {
    throw new CollectiveServiceError('WORK_RESULT_NOT_CURRENT', 'Only the current returned result can be revised', 409);
  }
  const nextWorkRevision = work.revision + 1;
  appendEvent(state, {
    coordinates: {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      clientEventId: `work-revision:${work.workId}:${input.requestId}`,
      target: { kind: 'agent', humanId: work.assignment.humanId, agentId: work.assignment.catId },
      location: {
        channelId: work.sourceLocation.channelId,
        rootEventId: work.sourceLocation.rootEventId ?? work.sourceEventId,
      },
      recipient: {
        kind: 'agent',
        humanId: work.assignment.humanId,
        connectionId: work.assignment.connectionId,
        agentId: work.assignment.catId,
        participationRevision: work.executionAuthority?.participationRevision ?? work.assignment.participationRevision,
      },
      replyToEventId: input.resultEventId,
      workRequest: 'revise',
      workRevisionNotice: {
        v: 1,
        workId: work.workId,
        workRevision: nextWorkRevision,
        assignmentEventId: work.assignmentEventId,
        resultEventId: input.resultEventId,
        resultRevision: input.resultRevision,
      },
      body: input.feedback,
    },
    actorScope,
    actor: humanEventActor(human),
    now,
  });
  work.lifecycle = 'in_progress';
  if (work.executionAuthority) work.executionAuthority.resultRevision = input.resultRevision + 1;
  const at = new Date(now).toISOString();
  advanceWork(
    work,
    'revision_requested',
    humanActor(human),
    at,
    input.resultEventId,
    input.feedback,
    input.resultRevision,
  );
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
