import {
  type CollectiveWorkProjection,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  type EntrustedWorkV1,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import {
  EntrustedWorkLifecycleError,
  EntrustedWorkLifecycleService,
} from '../../growing/EntrustedWorkLifecycleService.js';

interface CollectiveWorkResultReconcilerOptions {
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly tasks: ITaskStore;
}

export class CollectiveWorkResultReconciler {
  constructor(private readonly options: CollectiveWorkResultReconcilerOptions) {}

  async reconcile(input: {
    readonly ownerUserId: string;
    readonly sourceMessageId: string;
    readonly work: CollectiveWorkProjection;
  }) {
    const source = await this.options.messages.getById(input.sourceMessageId);
    const acceptedSource = requireAcceptedSource(source, input.ownerUserId, input.work);
    const assignment = acceptedSource.assignment;

    const sourceRef = `message:${acceptedSource.source.id}`;
    const tasks = (await this.options.tasks.listByKind('work')).filter(
      (task) =>
        task.userId === input.ownerUserId &&
        task.ownerCatId === assignment.catId &&
        task.entrustedWork?.admission.sourceRefs.length === 1 &&
        task.entrustedWork.admission.sourceRefs[0] === sourceRef,
    );
    if (tasks.length === 0) return { result: 'not_admitted' as const };
    if (tasks.length !== 1) {
      throw resultError('COLLECTIVE_RESULT_TASK_AMBIGUOUS', 'Accepted Work maps to more than one private Task');
    }
    const task = tasks[0];
    const work = task?.entrustedWork;
    if (!task || !work) {
      throw resultError('COLLECTIVE_RESULT_TASK_UNAVAILABLE', 'Accepted Work has no current entrusted Task');
    }
    return closeAcceptedTask(this.options.tasks, task.id, work, acceptedEvidence(input.work));
  }
}

async function closeAcceptedTask(tasks: ITaskStore, taskId: string, work: EntrustedWorkV1, evidenceRefs: string[]) {
  if (work.closure.state !== 'open') {
    return terminalResult(taskId, work, evidenceRefs);
  }
  if (work.closure.expectedSignal !== 'collective:accepted-result') {
    throw resultError('COLLECTIVE_RESULT_SIGNAL_MISMATCH', 'Private Task expects a different terminal signal');
  }
  try {
    const closed = await new EntrustedWorkLifecycleService(tasks).close({
      taskId,
      expectedRevision: work.revision,
      closure: {
        state: 'satisfied',
        condition: work.closure.condition,
        expectedSignal: work.closure.expectedSignal,
        evidenceRefs,
      },
    });
    const closedWork = closed.entrustedWork;
    if (!closedWork) throw resultError('COLLECTIVE_RESULT_TASK_UNAVAILABLE', 'Closed Task lost its Work contract');
    return { result: 'closed' as const, taskId: closed.id, revision: closedWork.revision };
  } catch (error) {
    const current = retryableClosureConflict(error) ? await tasks.get(taskId) : undefined;
    const currentWork = current?.entrustedWork;
    if (current && currentWork && currentWork.closure.state !== 'open') {
      return terminalResult(current.id, currentWork, evidenceRefs);
    }
    throw error;
  }
}

function terminalResult(taskId: string, work: EntrustedWorkV1, evidenceRefs: readonly string[]) {
  const exact =
    work.closure.state === 'satisfied' &&
    work.closure.expectedSignal === 'collective:accepted-result' &&
    evidenceRefs.every((reference) => work.closure.evidenceRefs.includes(reference));
  return {
    result: exact ? ('already_closed' as const) : ('terminal_unchanged' as const),
    taskId,
    revision: work.revision,
  };
}

function retryableClosureConflict(error: unknown) {
  return (
    error instanceof EntrustedWorkLifecycleError &&
    (error.code === 'ENTRUSTED_WORK_ALREADY_CLOSED' || error.code === 'ENTRUSTED_WORK_REVISION_CONFLICT')
  );
}

function requireAcceptedSource(source: StoredMessage | null, ownerUserId: string, work: CollectiveWorkProjection) {
  if (!currentOwnerSource(source, ownerUserId)) {
    throw resultError('COLLECTIVE_RESULT_SOURCE_MISMATCH', 'Accepted Work has no current Host source');
  }
  const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  const assignment = work.assignment;
  if (
    !identity.success ||
    !assignment ||
    !acceptedWork(work) ||
    !collectiveWorkAssignmentMatches(identity.data, work, source.source?.meta?.workAcceptanceNotice)
  ) {
    throw resultError('COLLECTIVE_RESULT_SOURCE_MISMATCH', 'Accepted Work does not match its current Host source');
  }
  return { source, assignment };
}

function currentOwnerSource(source: StoredMessage | null, ownerUserId: string): source is StoredMessage {
  return Boolean(source && !source.deletedAt && !source.recall && !source._tombstone && source.userId === ownerUserId);
}

function acceptedWork(work: CollectiveWorkProjection) {
  return (
    work.assignmentEventId !== undefined &&
    work.resultEventId !== undefined &&
    work.lifecycle === 'completed' &&
    work.status === 'completed' &&
    work.history.some(
      (entry) =>
        entry.action === 'result_accepted' &&
        entry.eventId === work.resultEventId &&
        (entry.resultRevision ?? 1) === (work.resultRevision ?? 1),
    )
  );
}

function acceptedEvidence(work: CollectiveWorkProjection): string[] {
  const acceptedRevision = work.history.find(
    (entry) =>
      entry.action === 'result_accepted' &&
      entry.eventId === work.resultEventId &&
      (entry.resultRevision ?? 1) === (work.resultRevision ?? 1),
  )?.revision;
  if (!acceptedRevision) throw resultError('COLLECTIVE_RESULT_NOT_ACCEPTED', 'Work has no accepted-result history');
  return [
    `collective:${work.serviceInstanceId}:${work.collectiveId}:${work.workId}:revision:${acceptedRevision}`,
    `collective:event:${work.assignmentEventId}`,
    `collective:event:${work.resultEventId}`,
  ];
}

function resultError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
