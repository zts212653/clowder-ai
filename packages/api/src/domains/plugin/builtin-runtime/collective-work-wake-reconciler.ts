import type { ConnectorInboxItem } from '@cat-cafe/collective-connector';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import { executionPointerForTask } from './collective-work/collective-work-execution-receipt.js';
import type { CollectiveWorkDispatcher } from './collective-work-dispatcher.js';
import { resolveAssignedWorkTask } from './collective-work-task-resolution.js';

interface WakeInput {
  readonly ownerUserId: string;
  readonly event: CollectiveEventEnvelope;
  readonly inbox: readonly ConnectorInboxItem[];
  readonly work: CollectiveWorkProjection;
}

/** Routes a Service-issued prerequisite/comment signal back to the one existing private Task. */
export class CollectiveWorkWakeReconciler {
  constructor(
    private readonly options: {
      readonly messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
      readonly tasks: ITaskStore;
      readonly dispatcher: Pick<CollectiveWorkDispatcher, 'dispatch'>;
    },
  ) {}

  async reconcile(input: WakeInput) {
    return this.dispatchPrepared(await this.prepare(input));
  }

  async prepare(input: WakeInput) {
    const { event, work } = input;
    const notice = event.workWakeNotice;
    const assignment = work.assignment;
    const recipient = event.recipient;
    const executionRevision = work.executionAuthority?.revision ?? 1;
    if (
      event.actor.kind !== 'human' ||
      event.workRequest !== 'resume' ||
      !notice ||
      !assignment ||
      !work.assignmentEventId ||
      !['committed', 'in_progress'].includes(work.lifecycle) ||
      work.workId !== notice.workId ||
      work.revision !== notice.workRevision ||
      work.assignmentEventId !== notice.assignmentEventId ||
      executionRevision !== notice.executionRevision ||
      work.executionStatus?.state === 'unavailable' ||
      recipient?.kind !== 'agent' ||
      recipient.connectionId !== assignment.connectionId ||
      recipient.humanId !== assignment.humanId ||
      recipient.agentId !== assignment.catId ||
      recipient.participationRevision !==
        (work.executionAuthority?.participationRevision ?? assignment.participationRevision) ||
      !wakeReasonMatches(work, event)
    )
      throw wakeError('COLLECTIVE_WORK_WAKE_NOT_CURRENT', 'Collective Work wake is no longer current');

    const { task, revision } = await resolveAssignedWorkTask(this.options, input, (kind) =>
      kind === 'source'
        ? wakeError('COLLECTIVE_WORK_WAKE_SOURCE_UNAVAILABLE', 'Collective Work assignment source changed')
        : wakeError('COLLECTIVE_WORK_WAKE_TASK_UNAVAILABLE', 'Collective Work has no unique open Host Task'),
    );
    return {
      task,
      ownerUserId: input.ownerUserId,
      revision,
      operation: {
        kind: 'resume' as const,
        ...(await executionPointerForTask(task, work, this.options.messages)),
        requestId: `collective-work-wake:${event.eventId}`,
        resultRevision:
          work.executionAuthority?.resultRevision ?? (work.resultEventId ? (work.resultRevision ?? 1) + 1 : 1),
        feedbackEventId: event.eventId,
        feedbackText: event.body,
      },
    };
  }

  async dispatchPrepared(prepared: Awaited<ReturnType<CollectiveWorkWakeReconciler['prepare']>>) {
    const dispatch = await this.options.dispatcher.dispatch(
      prepared.task,
      prepared.ownerUserId,
      prepared.revision,
      prepared.operation,
    );
    return { taskId: prepared.task.id, revision: prepared.revision, dispatch };
  }
}

function wakeReasonMatches(work: CollectiveWorkProjection, event: CollectiveEventEnvelope) {
  const notice = event.workWakeNotice;
  if (!notice) return false;
  if (notice.reason === 'dependency_completed') {
    const dependencyWorkId = notice.dependencyWorkId;
    return Boolean(dependencyWorkId && work.dependencyWorkIds.includes(dependencyWorkId) && work.status !== 'blocked');
  }
  const referenced = event.replyToEventId;
  if (!referenced) return false;
  const directlyReferenced = [
    work.sourceEventId,
    work.assignmentEventId,
    work.resultEventId,
    work.executionAuthority?.eventId,
    work.executionAuthority?.sourceEventId,
    ...work.history.flatMap((entry) => [
      entry.eventId,
      ...(entry.action === 'execution_authorized' ? [entry.note] : []),
    ]),
  ].includes(referenced);
  const workRoot = work.sourceLocation.rootEventId ?? work.sourceEventId;
  return directlyReferenced || event.location?.rootEventId === workRoot;
}

function wakeError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
