import type { CompleteCollectiveWorkRequest } from '@cat-cafe/shared';
import { advanceWork, humanActor, mutableWork } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  projectCollectiveWork,
  requireCollectiveWork,
  requireWorkAccountableHuman,
  requireWorkRevision,
} from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import type { MutableServiceState } from './state.js';

export function completeCollectiveWork(
  state: MutableServiceState,
  input: CompleteCollectiveWorkRequest,
  human: { humanId: string; displayName: string },
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
  if (work.assignment) {
    throw new CollectiveServiceError(
      'WORK_RESULT_REQUIRED',
      'Assigned Work must return a result for Human review',
      409,
    );
  }
  if (work.lifecycle !== 'committed') {
    throw new CollectiveServiceError('WORK_NOT_COMMITTED', 'Only committed self-owned Work can be completed', 409);
  }
  if (projectCollectiveWork(state, work, now).status === 'blocked') {
    throw new CollectiveServiceError(
      'WORK_DEPENDENCIES_INCOMPLETE',
      'Work cannot complete until its dependencies are complete',
      409,
    );
  }
  work.lifecycle = 'completed';
  const at = new Date(now).toISOString();
  advanceWork(work, 'completed', humanActor(human), at);
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
