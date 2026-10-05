import type {
  CollectiveCollaborationActor,
  CollectiveEventEnvelope,
  CollectiveWorkAcceptanceNotice,
  CommitCollectiveWorkRequest,
} from '@cat-cafe/shared';
import { advanceWork, humanActor, humanEventActor, mutableWork } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { projectCollectiveWork, requireCollectiveWork, requireWorkRevision } from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { requireParticipant } from './participation-store.js';
import type { MutableServiceState } from './state.js';

export function commitCollectiveWork(
  state: MutableServiceState,
  input: CommitCollectiveWorkRequest,
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
  if (work.lifecycle !== 'proposed') {
    throw new CollectiveServiceError('WORK_NOT_PROPOSED', 'Only a proposed Work can be committed', 409);
  }
  commitCollectiveWorkAssignment(state, input, work, human, actorScope, humanActor(human), humanEventActor(human), now);
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

export function commitCollectiveWorkAssignment(
  state: MutableServiceState,
  input: Pick<CommitCollectiveWorkRequest, 'serviceInstanceId' | 'collectiveId' | 'assignment'>,
  work: MutableServiceState['works'][string],
  human: { humanId: string; displayName: string },
  actorScope: string,
  actor: CollectiveCollaborationActor,
  eventActor: CollectiveEventEnvelope['actor'],
  now: number,
  acceptance?: CollectiveWorkAcceptanceNotice,
) {
  const at = new Date(now).toISOString();
  let assignmentEventId: string | undefined;
  if (input.assignment) {
    const participant = requireParticipant(state, {
      ...input,
      ...input.assignment,
      humanId: human.humanId,
      channelId: work.sourceLocation.channelId,
    });
    const rootEventId = work.sourceLocation.rootEventId ?? work.sourceEventId;
    const assignment = appendEvent(state, {
      coordinates: {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        clientEventId: `work-assignment:${work.workId}:${work.revision + 1}`,
        target: { kind: 'agent', humanId: human.humanId, agentId: participant.catId },
        location: { channelId: work.sourceLocation.channelId, rootEventId },
        recipient: {
          kind: 'agent',
          humanId: human.humanId,
          connectionId: input.assignment.connectionId,
          agentId: participant.catId,
          participationRevision: input.assignment.participationRevision,
        },
        replyToEventId: work.sourceEventId,
        workRequest: 'entrust',
        ...(acceptance ? { workAcceptanceNotice: acceptance } : {}),
        body: acceptance ? `我接下了：${work.title}` : work.intendedOutcome,
      },
      actorScope,
      actor: eventActor,
      now,
    });
    assignmentEventId = assignment.eventId;
    work.assignment = {
      humanId: human.humanId,
      connectionId: input.assignment.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: input.assignment.participationRevision,
      assignedAt: at,
    };
    work.assignmentEventId = assignmentEventId;
  }
  work.accountableHumanId = human.humanId;
  work.lifecycle = 'committed';
  advanceWork(work, 'committed', actor, at, assignmentEventId);
}
