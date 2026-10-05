import type {
  CollectiveAgentMessageRequest,
  CollectiveEventEnvelope,
  CollectiveWorkProgressReceipt,
} from '@cat-cafe/shared';
import { collaborationActorFromEvent } from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import type { MutableServiceState, ServiceState } from './state.js';
import { requireAcceptedWorkExecution } from './work-execution-authority.js';

export function issueCollectiveWorkProgressReceipt(
  state: ServiceState,
  input: CollectiveAgentMessageRequest,
  actor: { connectionId: string; humanId: string; catId: string },
  now: number,
): CollectiveWorkProgressReceipt | undefined {
  const intent = input.workProgressIntent;
  if (!intent) return;
  const work = Object.values(state.works).find(
    (candidate) =>
      candidate.collectiveId === input.collectiveId && candidate.assignmentEventId === intent.assignmentEventId,
  );
  const assignmentCatId = intent.assignmentCatId ?? actor.catId;
  if (
    !work?.assignment ||
    input.replyToEventId !== work.assignmentEventId ||
    work.assignment.connectionId !== actor.connectionId ||
    work.assignment.humanId !== actor.humanId ||
    work.assignment.catId !== assignmentCatId ||
    input.participationRevision !== intent.participationRevision ||
    intent.participationRevision !==
      (work.executionAuthority?.participationRevision ?? work.assignment.participationRevision)
  )
    throw new CollectiveServiceError(
      'RETURN_UNAVAILABLE',
      'Progress is not bound to the current exact assignment',
      409,
    );
  if (intent.executionRevision !== (work.executionAuthority?.revision ?? 1))
    throw new CollectiveServiceError(
      'WORK_EXECUTION_NOT_CURRENT',
      'Progress belongs to an older execution authority',
      409,
    );
  requireAcceptedWorkExecution(state, work, now);
  const receipt = { ...intent, assignmentCatId, workId: work.workId, ...actor };
  const replayId =
    state.clientEventIndex[`${input.collectiveId}:connection:${actor.connectionId}:${input.clientEventId}`];
  const replay = replayId
    ? (state.events[input.collectiveId] ?? []).find((event) => event.eventId === replayId)
    : undefined;
  if (replay?.workProgressReceipt) return receipt;
  if (
    !['committed', 'in_progress'].includes(work.lifecycle) ||
    intent.resultRevision !== (work.resultEventId ? (work.resultRevision ?? 1) : 0) + 1
  )
    throw new CollectiveServiceError(
      'WORK_RESULT_REVISION_CONFLICT',
      'Progress does not match the current execution round',
      409,
    );
  return receipt;
}

export function recordCollectiveWorkProgress(state: MutableServiceState, event: CollectiveEventEnvelope): void {
  const receipt = event.workProgressReceipt;
  if (!receipt) return;
  const work = state.works[receipt.workId];
  if (!work || work.history.some((entry) => entry.eventId === event.eventId)) return;
  work.lifecycle = 'in_progress';
  work.revision += 1;
  work.updatedAt = event.acceptedAt;
  work.history.push({
    revision: work.revision,
    action: 'progress_reported',
    actor: collaborationActorFromEvent(event),
    at: event.acceptedAt,
    eventId: event.eventId,
    note: event.body.slice(0, 1000),
  });
}
