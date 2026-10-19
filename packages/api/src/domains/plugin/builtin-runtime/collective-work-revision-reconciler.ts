import type { ConnectorInboxItem } from '@cat-cafe/collective-connector';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import { executionPointerForTask } from './collective-work/collective-work-execution-receipt.js';
import type { CollectiveWorkDispatcher } from './collective-work-dispatcher.js';
import { resolveAssignedWorkTask } from './collective-work-task-resolution.js';

interface CollectiveWorkRevisionReconcilerOptions {
  readonly messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
  readonly tasks: ITaskStore;
  readonly dispatcher: Pick<CollectiveWorkDispatcher, 'dispatch'>;
}

interface RevisionInput {
  readonly ownerUserId: string;
  readonly event: CollectiveEventEnvelope;
  readonly inbox: readonly ConnectorInboxItem[];
  readonly work: CollectiveWorkProjection;
}

/** Maps a Service-authenticated revision event back to the one admitted Host Task. */
export class CollectiveWorkRevisionReconciler {
  constructor(private readonly options: CollectiveWorkRevisionReconcilerOptions) {}

  async reconcile(input: RevisionInput) {
    return this.dispatchPrepared(await this.prepare(input));
  }

  async prepare(input: RevisionInput) {
    const { event, work } = input;
    const notice = event.workRevisionNotice;
    const assignment = work.assignment;
    const recipient = event.recipient;
    if (event.actor.kind !== 'human') {
      throw revisionError('COLLECTIVE_REVISION_NOT_CURRENT', 'Collective revision feedback is no longer current');
    }
    const feedbackHumanId = event.actor.humanId;
    if (
      event.workRequest !== 'revise' ||
      !notice ||
      !assignment ||
      !work.assignmentEventId ||
      !work.resultEventId ||
      work.lifecycle !== 'in_progress' ||
      work.status !== 'in_progress' ||
      work.revision !== notice.workRevision ||
      work.workId !== notice.workId ||
      work.assignmentEventId !== notice.assignmentEventId ||
      work.resultEventId !== notice.resultEventId ||
      (work.resultRevision ?? 1) !== notice.resultRevision ||
      event.replyToEventId !== notice.resultEventId ||
      feedbackHumanId !== work.accountableHumanId ||
      recipient?.kind !== 'agent' ||
      recipient.connectionId !== assignment.connectionId ||
      recipient.humanId !== assignment.humanId ||
      recipient.agentId !== assignment.catId ||
      recipient.participationRevision !==
        (work.executionAuthority?.participationRevision ?? assignment.participationRevision) ||
      !work.history.some(
        (entry) =>
          entry.revision === notice.workRevision &&
          entry.action === 'revision_requested' &&
          entry.eventId === notice.resultEventId &&
          entry.resultRevision === notice.resultRevision &&
          entry.note === event.body &&
          entry.actor.kind === 'human' &&
          entry.actor.humanId === feedbackHumanId,
      )
    ) {
      throw revisionError('COLLECTIVE_REVISION_NOT_CURRENT', 'Collective revision feedback is no longer current');
    }
    const { task, revision } = await resolveAssignedWorkTask(this.options, input, (kind) =>
      kind === 'source'
        ? revisionError('COLLECTIVE_REVISION_SOURCE_UNAVAILABLE', 'Collective Work assignment source changed')
        : revisionError('COLLECTIVE_REVISION_TASK_UNAVAILABLE', 'Collective revision has no unique open Host Task'),
    );
    return {
      task,
      ownerUserId: input.ownerUserId,
      revision,
      operation: {
        kind: 'revision' as const,
        ...(await executionPointerForTask(task, work, this.options.messages)),
        requestId: `collective-work-revision:${event.eventId}`,
        resultRevision: notice.resultRevision + 1,
        feedbackEventId: event.eventId,
        feedbackText: event.body,
      },
    };
  }

  async dispatchPrepared(prepared: Awaited<ReturnType<CollectiveWorkRevisionReconciler['prepare']>>) {
    const dispatch = await this.options.dispatcher.dispatch(
      prepared.task,
      prepared.ownerUserId,
      prepared.revision,
      prepared.operation,
    );
    return { taskId: prepared.task.id, revision: prepared.revision, dispatch };
  }
}

function revisionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
