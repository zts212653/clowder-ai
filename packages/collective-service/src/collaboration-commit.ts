import type {
  CollectiveCollaborationActor,
  CollectiveEventEnvelope,
  CollectiveWorkAcceptanceNotice,
  CommitCollectiveWorkRequest,
} from '@cat-cafe/shared';
import { advanceWork, humanActor, humanEventActor, mutableWork } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  isAcceptedUnassignedWork,
  projectCollectiveWork,
  requireCollectiveWork,
  requireOrdinaryWorkTransition,
  requireWorkRevision,
} from './collaboration-work.js';
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
  requireOrdinaryWorkTransition(work);
  const acceptingUnassigned = work.lifecycle === 'proposed' && input.accountability === 'unassigned';
  const alreadyUnassigned = isAcceptedUnassignedWork(work);
  const keepingUnassigned = alreadyUnassigned && input.accountability === 'unassigned';
  const claimingUnassigned = alreadyUnassigned && !keepingUnassigned;
  if (work.lifecycle !== 'proposed' && !alreadyUnassigned) {
    throw new CollectiveServiceError(
      'WORK_NOT_PROPOSED',
      'Only proposed or accepted unassigned Work can be committed',
      409,
    );
  }
  if (acceptingUnassigned) {
    commitCollectiveWorkUnassigned(work, human, now);
  } else if (!keepingUnassigned) {
    commitCollectiveWorkAssignment(
      state,
      input,
      work,
      human,
      actorScope,
      humanActor(human),
      humanEventActor(human),
      now,
      undefined,
      claimingUnassigned ? 'accountability_assigned' : 'committed',
    );
  }
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
  historyAction: 'committed' | 'accountability_assigned' | 'accountability_request_accepted' = 'committed',
  historyEventId?: string,
  resolvesPendingAccountabilityRequest = false,
) {
  requireOrdinaryWorkTransition(work);
  if (
    !resolvesPendingAccountabilityRequest &&
    work.accountabilityRequests?.some((request) => request.status === 'pending')
  ) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_PENDING',
      'The named Human must answer the pending responsibility request before this Task can be claimed',
      409,
    );
  }
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
  advanceWork(work, historyAction, actor, at, historyEventId ?? assignmentEventId);
}

/** Low-level transition used after the caller has already proven the relevant decision authority. */
export function commitCollectiveWorkUnassigned(
  work: MutableServiceState['works'][string],
  human: { humanId: string; displayName: string },
  now: number,
) {
  const at = new Date(now).toISOString();
  work.lifecycle = 'committed';
  advanceWork(work, 'committed', humanActor(human), at, undefined, '已纳入任务，等待负责人接下');
}
