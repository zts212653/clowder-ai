import type { ConnectorInboxItem } from '@cat-cafe/collective-connector';
import {
  type CollectiveEventEnvelope,
  type CollectiveWorkProjection,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import { executionPointerForTask } from './collective-work/collective-work-execution-receipt.js';
import type { CollectiveWorkDispatcher } from './collective-work-dispatcher.js';

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
    const sources = input.inbox.filter((item) => assignmentInboxMatches(item, work, assignment));
    if (sources.length !== 1 || sources[0]?.routeReceipt?.kind !== 'thread_message') {
      throw revisionError(
        'COLLECTIVE_REVISION_SOURCE_UNAVAILABLE',
        'Collective Work has no unique Host assignment source',
      );
    }
    const source = await this.options.messages.getById(sources[0].routeReceipt.messageId);
    if (!sourceMatchesWork(source, input.ownerUserId, work, assignment)) {
      throw revisionError('COLLECTIVE_REVISION_SOURCE_UNAVAILABLE', 'Collective Work assignment source changed');
    }
    const sourceRef = `message:${source.id}`;
    const tasks = (await this.options.tasks.listByKind('work')).filter(
      (task) =>
        task.userId === input.ownerUserId &&
        task.ownerCatId === assignment.catId &&
        task.status !== 'done' &&
        task.entrustedWork?.closure.state === 'open' &&
        task.entrustedWork.admission.sourceRefs.length === 1 &&
        task.entrustedWork.admission.sourceRefs[0] === sourceRef,
    );
    const task = tasks[0];
    const contract = task?.entrustedWork;
    if (tasks.length !== 1 || !task || !contract) {
      throw revisionError('COLLECTIVE_REVISION_TASK_UNAVAILABLE', 'Collective revision has no unique open Host Task');
    }
    return {
      task,
      ownerUserId: input.ownerUserId,
      revision: contract.revision,
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

function assignmentInboxMatches(
  item: ConnectorInboxItem,
  work: CollectiveWorkProjection,
  assignment: NonNullable<CollectiveWorkProjection['assignment']>,
) {
  const recipient = item.event.recipient;
  return (
    item.event.eventId === work.assignmentEventId &&
    item.event.serviceInstanceId === work.serviceInstanceId &&
    item.event.collectiveId === work.collectiveId &&
    item.event.workRequest === 'entrust' &&
    item.disposition === 'routed' &&
    item.routeReceipt?.kind === 'thread_message' &&
    recipient?.kind === 'agent' &&
    recipient.connectionId === assignment.connectionId &&
    recipient.humanId === assignment.humanId &&
    recipient.agentId === assignment.catId &&
    recipient.participationRevision === assignment.participationRevision
  );
}

function sourceMatchesWork(
  source: StoredMessage | null,
  ownerUserId: string,
  work: CollectiveWorkProjection,
  assignment: NonNullable<CollectiveWorkProjection['assignment']>,
): source is StoredMessage {
  if (
    !source ||
    source.userId !== ownerUserId ||
    source.catId !== null ||
    source.deletedAt ||
    source.recall ||
    source._tombstone ||
    source.source?.meta?.workRequest !== 'entrust'
  ) {
    return false;
  }
  const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  return (
    identity.success &&
    assignment === work.assignment &&
    collectiveWorkAssignmentMatches(identity.data, work, source.source?.meta?.workAcceptanceNotice)
  );
}

function revisionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
