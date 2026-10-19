import type { CollectiveEventEnvelope, CollectiveHumanMessageRequest, CollectiveWorkRecord } from '@cat-cafe/shared';
import { workReferences } from './collaboration-agent-continuation.js';
import { humanEventActor } from './collaboration-command-helpers.js';
import { projectCollectiveWork } from './collaboration-work.js';
import { appendEvent } from './event-log.js';
import { requireParticipant } from './participation-store.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string; readonly avatarUrl?: string };

export function emitHumanCommentWake(
  state: MutableServiceState,
  input: CollectiveHumanMessageRequest,
  comment: CollectiveEventEnvelope,
  human: Human,
  now: number,
) {
  if (!input.replyToEventId || !comment.location) return;
  const candidates = Object.values(state.works).filter(
    (work) =>
      work.collectiveId === input.collectiveId &&
      work.sourceLocation.channelId === input.location?.channelId &&
      commentReferencesWork(work, input) &&
      isWakeable(state, work, false),
  );
  const work = candidates.length === 1 ? candidates[0] : undefined;
  if (!work?.assignment || !work.assignmentEventId) return;
  appendEvent(state, {
    coordinates: {
      serviceInstanceId: state.serviceInstanceId,
      collectiveId: work.collectiveId,
      clientEventId: `work-wake:comment:${comment.eventId}:${work.workId}`,
      target: { kind: 'agent', humanId: work.assignment.humanId, agentId: work.assignment.catId },
      location: comment.location,
      recipient: {
        kind: 'agent',
        humanId: work.assignment.humanId,
        connectionId: work.assignment.connectionId,
        agentId: work.assignment.catId,
        participationRevision: currentParticipationRevision(work),
      },
      replyToEventId: comment.eventId,
      workRequest: 'resume',
      workWakeNotice: {
        v: 1,
        reason: 'comment',
        workId: work.workId,
        workRevision: work.revision,
        assignmentEventId: work.assignmentEventId,
        executionRevision: work.executionAuthority?.revision ?? 1,
      },
      body: comment.body,
    },
    actorScope: `service:work-wake:comment:${human.humanId}`,
    actor: humanEventActor(human),
    now,
  });
}

export function emitDependencyCompletionWakes(
  state: MutableServiceState,
  completed: CollectiveWorkRecord,
  human: Human,
  now: number,
) {
  for (const work of Object.values(state.works)) {
    if (
      work.collectiveId !== completed.collectiveId ||
      !work.dependencyWorkIds.includes(completed.workId) ||
      !isWakeable(state, work, true) ||
      !work.assignment ||
      !work.assignmentEventId
    )
      continue;
    appendEvent(state, {
      coordinates: {
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: work.collectiveId,
        clientEventId: `work-wake:dependency:${completed.workId}:${completed.revision}:${work.workId}:${work.revision}`,
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
          participationRevision: currentParticipationRevision(work),
        },
        replyToEventId: work.assignmentEventId,
        workRequest: 'resume',
        workWakeNotice: {
          v: 1,
          reason: 'dependency_completed',
          workId: work.workId,
          workRevision: work.revision,
          assignmentEventId: work.assignmentEventId,
          executionRevision: work.executionAuthority?.revision ?? 1,
          dependencyWorkId: completed.workId,
          dependencyWorkRevision: completed.revision,
        },
        body: `前置任务“${completed.title}”已完成；请沿原任务继续“${work.title}”。`.slice(0, 32_000),
      },
      actorScope: `service:work-wake:${human.humanId}`,
      actor: humanEventActor(human),
      now,
    });
  }
}

function commentReferencesWork(
  work: CollectiveWorkRecord,
  input: Pick<CollectiveHumanMessageRequest, 'replyToEventId' | 'location'>,
) {
  if (input.replyToEventId && workReferences(work, input.replyToEventId)) return true;
  const commentRoot = input.location?.rootEventId;
  const workRoot = work.sourceLocation.rootEventId ?? work.sourceEventId;
  return Boolean(commentRoot && commentRoot === workRoot);
}

function isWakeable(state: MutableServiceState, work: CollectiveWorkRecord, requireDependenciesComplete: boolean) {
  if (
    !work.assignment ||
    !work.assignmentEventId ||
    !work.accountableHumanId ||
    !['committed', 'in_progress'].includes(work.lifecycle) ||
    (requireDependenciesComplete &&
      work.dependencyWorkIds.some((dependencyId) => state.works[dependencyId]?.lifecycle !== 'completed'))
  )
    return false;
  try {
    requireParticipant(state, {
      ...work.assignment,
      collectiveId: work.collectiveId,
      channelId: work.sourceLocation.channelId,
      participationRevision: currentParticipationRevision(work),
    });
  } catch {
    return false;
  }
  return projectCollectiveWork(state, work).executionStatus?.state !== 'unavailable';
}

function currentParticipationRevision(work: CollectiveWorkRecord) {
  return work.executionAuthority?.participationRevision ?? work.assignment?.participationRevision ?? 0;
}
