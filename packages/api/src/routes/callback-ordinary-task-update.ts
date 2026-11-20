import type { TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import type { OrdinaryTaskHandoffService } from '../domains/ball-custody/OrdinaryTaskHandoffService.js';
import { hasOutstandingDeploymentWait } from '../domains/ball-custody/ordinary-task-deployment-wait.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import {
  type OrdinaryTaskMutationResult,
  ordinaryTaskExpectation,
} from '../domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { TaskMutationWriteFence } from '../domains/cats/services/stores/ports/TaskStoreContract.js';

/** Actor identity and source assignment are checked at the aggregate write, not a preliminary GET. */
export async function updateOrdinaryTaskFromCallback(input: {
  task: TaskItem;
  record: InvocationRecord;
  data: Pick<UpdateTaskInput, 'status' | 'why' | 'dispatchGate'>;
  expectedOwnerRevision?: number;
  finalReport?: TaskItem['ordinaryFinalReport'];
  tasks: ITaskStore;
  messages: Pick<IMessageStore, 'getById'>;
  fence: TaskMutationWriteFence;
  handoffs?: OrdinaryTaskHandoffService;
}): Promise<OrdinaryTaskMutationResult | { kind: 'refused'; reason: string; task: TaskItem }> {
  const { record, task } = input;
  if (input.data.status === 'done' && record.threadId !== task.threadId && hasOutstandingDeploymentWait(task))
    return { kind: 'refused', reason: 'task_wait_active', task };
  const exactExecution = task.executionRef?.invocationId === record.invocationId;
  const sourceId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  const source = sourceId ? await input.messages.getById(sourceId) : null;
  const handoff = source?.extra?.taskHandoff;
  if (input.data.status === 'done' && handoff && 'approval' in handoff.issuer && !input.finalReport)
    return { kind: 'refused', reason: 'task_result_message_required', task };
  if (source?.extra?.taskHandoffInvalid || source?.deletedAt || source?.recall || source?._tombstone)
    return { kind: 'refused' as const, reason: 'task_source_withdrawn', task };
  const sourceRevision = handoff
    ? handoff.expected.ownerRevision + Number(handoff.expected.ownerCatId !== handoff.ownerCatId)
    : (input.expectedOwnerRevision ?? task.ownerRevision ?? 0);
  if (
    handoff &&
    (handoff.taskId !== task.id ||
      task.lastAppliedHandoffMessageRef !== `message:${sourceId}` ||
      handoff.targetCatId !== record.catId ||
      handoff.targetThreadId !== record.threadId)
  )
    return { kind: 'refused' as const, reason: 'task_assignment_changed', task };
  const assignmentId = task.lastAppliedHandoffMessageRef?.slice('message:'.length);
  const assignment = !handoff && assignmentId ? await input.messages.getById(assignmentId) : null;
  const issuer = assignment?.extra?.taskHandoff?.issuer;
  const issuerMetadataOnly = Boolean(
    input.data.status === undefined &&
      input.expectedOwnerRevision === (task.ownerRevision ?? 0) &&
      task.ownerCatId === record.catId &&
      task.threadId === record.threadId &&
      issuer &&
      'invocationId' in issuer &&
      issuer.invocationId === record.invocationId &&
      issuer.threadId === record.threadId &&
      issuer.userId === record.userId &&
      assignment?.extra?.taskHandoff?.taskId === task.id &&
      assignment.extra.taskHandoff.expected.ownerRevision === (task.ownerRevision ?? 0),
  );
  if (
    !handoff &&
    assignmentId &&
    (!assignment ||
      assignment.deletedAt ||
      assignment.recall ||
      assignment._tombstone ||
      (!issuerMetadataOnly && record.createdAt <= assignment.timestamp))
  )
    return { kind: 'refused' as const, reason: 'task_assignment_changed', task };
  if (!handoff && !exactExecution && task.ownerChangedAt !== undefined && record.createdAt <= task.ownerChangedAt)
    return { kind: 'refused' as const, reason: 'task_assignment_changed', task };
  // Check source/assignment before housekeeping: an old callback must not clear a newer binding.
  if (
    task.executionRef &&
    !exactExecution &&
    !issuerMetadataOnly &&
    task.ownerCatId === record.catId &&
    task.threadId === record.threadId &&
    task.userId === record.userId
  ) {
    if (!(await input.handoffs?.releaseStoppedExecution(task)))
      return { kind: 'refused', reason: 'task_execution_stop_unproven', task };
    const current = await input.tasks.get(task.id);
    if (!current) return { kind: 'not_found' };
    // Re-run all checks on the current assignment; recovery is attempted at most once.
    return updateOrdinaryTaskFromCallback({ ...input, task: current, handoffs: undefined });
  }
  return input.tasks.mutateOrdinaryTask(
    {
      kind: 'update',
      taskId: task.id,
      expected: { ...ordinaryTaskExpectation(task), ownerRevision: sourceRevision },
      actor: {
        userId: record.userId,
        catId: record.catId,
        threadId: record.threadId,
        invocationId: record.invocationId,
      },
      input: input.data,
      ...(input.finalReport ? { finalReport: input.finalReport } : {}),
      ...(issuerMetadataOnly ? { issuerMetadataOnly } : {}),
      ...(input.data.status === 'doing'
        ? {
            execution: {
              invocationId: record.invocationId,
              parentInvocationId: record.parentInvocationId ?? record.invocationId,
              catId: record.catId,
              threadId: record.threadId,
              sourceMessageId: sourceId ?? null,
            },
          }
        : {}),
    },
    {
      watchKeys: [
        ...(input.fence.watchKeys ?? []),
        `invoc:${record.invocationId}`,
        ...(sourceId ? [`msg:${sourceId}`] : []),
        ...(assignmentId ? [`msg:${assignmentId}`] : []),
      ],
      assertCurrent: async () => {
        await input.fence.assertCurrent();
        if (assignmentId && !handoff) {
          const current = await input.messages.getById(assignmentId);
          if (
            !current ||
            current.deletedAt ||
            current.recall ||
            current._tombstone ||
            current.timestamp !== assignment?.timestamp ||
            (issuerMetadataOnly &&
              JSON.stringify(current.extra?.taskHandoff) !== JSON.stringify(assignment?.extra?.taskHandoff))
          )
            throw new Error('task_assignment_source_changed');
        }
        if (sourceId) {
          const current = await input.messages.getById(sourceId);
          if (
            !current ||
            current.deletedAt ||
            current.recall ||
            current._tombstone ||
            JSON.stringify(current.extra?.taskHandoff) !== JSON.stringify(handoff)
          )
            throw new Error('task_source_withdrawn');
        }
      },
    },
  );
}
