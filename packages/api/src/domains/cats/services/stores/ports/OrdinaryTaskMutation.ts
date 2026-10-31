import type { CatId, TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { reconcileDeploymentWaitTaskMutation } from './TaskDeploymentWaitState.js';
import { reconcilePluginWaitTaskMutation } from './TaskPluginWait.js';
import { isOrdinaryImplementTask } from './TaskStoreContract.js';

type ExecutionRef = NonNullable<TaskItem['executionRef']>;

/** Server-authenticated coordinates, never copied from a tool's actor payload. */
export interface TaskMutationActor {
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly invocationId: string;
}

/** Revalidated inside the Task aggregate's conditional write, including ABA and execution races. */
export interface OrdinaryTaskExpectation {
  readonly userId: string;
  readonly ownerCatId: string | null;
  readonly threadId: string;
  readonly ownerRevision: number;
  readonly lastAppliedHandoffMessageRef: string | null;
  readonly executionRef: ExecutionRef | null;
}

export type OrdinaryTaskMutation = {
  readonly taskId: string;
  readonly expected: OrdinaryTaskExpectation;
} & (
  | {
      readonly kind: 'human_update';
      readonly userId: string;
      readonly input: UpdateTaskInput;
      readonly messageRef?: string;
    }
  | {
      readonly kind: 'update';
      readonly actor: TaskMutationActor;
      readonly input: Pick<UpdateTaskInput, 'status' | 'why' | 'dispatchGate'>;
      readonly execution?: ExecutionRef;
    }
  | { readonly kind: 'adopt_legacy_tenant'; readonly userId: string }
  | {
      readonly kind: 'handoff';
      readonly ownerCatId: CatId;
      readonly messageRef: string;
    }
  | { readonly kind: 'adopt_legacy_execution'; readonly execution: ExecutionRef }
  | { readonly kind: 'bind_execution'; readonly execution: ExecutionRef }
  | { readonly kind: 'release_execution'; readonly execution: ExecutionRef }
);

export type OrdinaryTaskMutationResult =
  | { readonly kind: 'updated' | 'replayed'; readonly task: TaskItem }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'refused';
      readonly reason: 'not_ordinary' | 'assignment_changed' | 'task_closed' | 'execution_changed' | 'actor_mismatch';
      readonly task: TaskItem;
    };

export function ordinaryTaskExpectation(task: TaskItem): OrdinaryTaskExpectation {
  return {
    userId: task.userId ?? '',
    ownerCatId: task.ownerCatId,
    threadId: task.threadId,
    ownerRevision: task.ownerRevision ?? 0,
    lastAppliedHandoffMessageRef: task.lastAppliedHandoffMessageRef ?? null,
    executionRef: task.executionRef ?? null,
  };
}

export function sameTaskExecution(a: TaskItem['executionRef'], b: TaskItem['executionRef']): boolean {
  if (a == null || b == null) return a == null && b == null;
  return (
    a.invocationId === b.invocationId &&
    a.parentInvocationId === b.parentInvocationId &&
    a.catId === b.catId &&
    a.threadId === b.threadId &&
    a.sourceMessageId === b.sourceMessageId
  );
}

/** Single decision shared by Memory and Redis, run only at the aggregate write boundary. */
export function mutateOrdinaryTask(
  task: TaskItem | null,
  command: OrdinaryTaskMutation,
  now: number,
): OrdinaryTaskMutationResult {
  const result = decideOrdinaryTaskMutation(task, command, now);
  return task && result.kind === 'updated'
    ? {
        ...result,
        task: reconcilePluginWaitTaskMutation(
          task,
          reconcileDeploymentWaitTaskMutation(task, result.task, {
            statusIsExplicit: 'input' in command && command.input.status !== undefined,
          }),
        ),
      }
    : result;
}

type RefusalReason = Extract<OrdinaryTaskMutationResult, { kind: 'refused' }>['reason'];
const refused = (task: TaskItem, reason: RefusalReason): OrdinaryTaskMutationResult => ({
  kind: 'refused',
  reason,
  task,
});
const updated = (task: TaskItem): OrdinaryTaskMutationResult => ({ kind: 'updated', task });

function assignmentMatches(task: TaskItem, e: OrdinaryTaskExpectation): boolean {
  return (
    task.ownerCatId === e.ownerCatId &&
    (task.ownerRevision ?? 0) === e.ownerRevision &&
    (task.lastAppliedHandoffMessageRef ?? null) === e.lastAppliedHandoffMessageRef
  );
}

function decideOrdinaryTaskMutation(
  task: TaskItem | null,
  command: OrdinaryTaskMutation,
  now: number,
): OrdinaryTaskMutationResult {
  if (!task) return { kind: 'not_found' };
  if (!isOrdinaryImplementTask(task)) return refused(task, 'not_ordinary');
  const e = command.expected;
  if (
    task.id !== command.taskId ||
    task.threadId !== e.threadId ||
    (command.kind === 'adopt_legacy_tenant'
      ? (task.userId ?? '') !== e.userId || !command.userId
      : !e.userId || task.userId !== e.userId)
  )
    return refused(task, 'assignment_changed');
  if (
    command.kind === 'human_update' &&
    command.messageRef &&
    task.lastAppliedHandoffMessageRef === command.messageRef
  ) {
    return command.userId === task.userId &&
      task.ownerCatId === command.input.ownerCatId &&
      (task.ownerRevision ?? 0) === command.expected.ownerRevision + 1 &&
      patchMatches(task, command.input)
      ? { kind: 'replayed', task }
      : refused(task, 'assignment_changed');
  }
  if (command.kind === 'handoff' && task.lastAppliedHandoffMessageRef === command.messageRef) {
    const revision = e.ownerRevision + Number(e.ownerCatId !== command.ownerCatId);
    return task.ownerCatId === command.ownerCatId && (task.ownerRevision ?? 0) === revision
      ? { kind: 'replayed', task }
      : refused(task, 'assignment_changed');
  }
  if (!assignmentMatches(task, e)) return refused(task, 'assignment_changed');
  if (!sameTaskExecution(task.executionRef, e.executionRef)) return refused(task, 'execution_changed');
  if (command.kind === 'adopt_legacy_tenant')
    return !task.userId
      ? updated({ ...task, userId: command.userId, updatedAt: now })
      : task.userId === command.userId
        ? { kind: 'replayed', task }
        : refused(task, 'actor_mismatch');
  if (command.kind === 'release_execution')
    return sameTaskExecution(task.executionRef, command.execution)
      ? updated({ ...task, executionRef: null, updatedAt: now })
      : refused(task, 'execution_changed');
  if (task.status === 'done') return replayClosedUpdate(task, command);
  return applyOpenMutation(task, command, now);
}

function patchMatches(task: TaskItem, input: UpdateTaskInput): boolean {
  return Object.entries(input).every(
    ([key, value]) => JSON.stringify(task[key as keyof TaskItem]) === JSON.stringify(value),
  );
}

function replayClosedUpdate(task: TaskItem, command: OrdinaryTaskMutation): OrdinaryTaskMutationResult {
  if (command.kind !== 'update' && command.kind !== 'human_update') return refused(task, 'task_closed');
  const actorMatches =
    command.kind === 'update' ? callbackActorMatches(task, command.actor) : command.userId === task.userId;
  const same = patchMatches(task, command.input);
  return actorMatches && same ? { kind: 'replayed', task } : refused(task, 'task_closed');
}

function applyOpenMutation(
  task: TaskItem,
  command: Exclude<OrdinaryTaskMutation, { kind: 'release_execution' }>,
  now: number,
): OrdinaryTaskMutationResult {
  switch (command.kind) {
    case 'human_update':
      return updateAsHuman(task, command, now);
    case 'update':
      return updateAsCallback(task, command, now);
    case 'adopt_legacy_tenant':
      return refused(task, 'actor_mismatch'); // Handled before open/closed business status.
    case 'adopt_legacy_execution':
      return task.ownerRevision === undefined && !task.executionRef
        ? updated({ ...task, executionRef: command.execution, updatedAt: now })
        : refused(task, 'execution_changed');
    case 'bind_execution':
      return bindExecution(task, command, now);
    case 'handoff':
      return applyHandoff(task, command, now);
  }
}

function updateAsCallback(
  task: TaskItem,
  command: Extract<OrdinaryTaskMutation, { kind: 'update' }>,
  now: number,
): OrdinaryTaskMutationResult {
  if (!callbackActorMatches(task, command.actor)) return refused(task, 'actor_mismatch');
  const execution = command.execution;
  if (
    execution &&
    (execution.invocationId !== command.actor.invocationId ||
      execution.catId !== command.actor.catId ||
      execution.threadId !== command.actor.threadId ||
      (task.executionRef && !sameTaskExecution(task.executionRef, execution)))
  )
    return refused(task, 'actor_mismatch');
  const pickedUp = task.ownerCatId === null && command.input.status === 'doing';
  return updated({
    ...task,
    ...command.input,
    ...(pickedUp
      ? { ownerCatId: command.actor.catId as CatId, ownerRevision: (task.ownerRevision ?? 0) + 1, ownerChangedAt: now }
      : {}),
    ...(execution && command.input.status === 'doing' ? { executionRef: execution } : {}),
    updatedAt: now,
  });
}

function updateAsHuman(
  task: TaskItem,
  command: Extract<OrdinaryTaskMutation, { kind: 'human_update' }>,
  now: number,
): OrdinaryTaskMutationResult {
  if (command.userId !== task.userId) return refused(task, 'actor_mismatch');
  const changes = command.input.ownerCatId !== undefined && command.input.ownerCatId !== task.ownerCatId;
  if (changes && task.executionRef) return refused(task, 'execution_changed');
  if (changes && !command.messageRef?.startsWith('message:')) return refused(task, 'assignment_changed');
  const next = advanceOrdinaryTaskAssignment(task, { ...task, ...command.input, updatedAt: now });
  return updated(changes ? { ...next, lastAppliedHandoffMessageRef: command.messageRef } : next);
}

function bindExecution(
  task: TaskItem,
  command: Extract<OrdinaryTaskMutation, { kind: 'bind_execution' }>,
  now: number,
): OrdinaryTaskMutationResult {
  if (task.executionRef)
    return sameTaskExecution(task.executionRef, command.execution)
      ? { kind: 'replayed', task }
      : refused(task, 'execution_changed');
  if (task.lastAppliedHandoffMessageRef !== `message:${command.execution.sourceMessageId}`)
    return refused(task, 'assignment_changed');
  return updated({ ...task, executionRef: command.execution, updatedAt: now });
}

function applyHandoff(
  task: TaskItem,
  command: Extract<OrdinaryTaskMutation, { kind: 'handoff' }>,
  now: number,
): OrdinaryTaskMutationResult {
  if (task.executionRef) return refused(task, 'execution_changed');
  if (!command.messageRef.startsWith('message:') || command.messageRef.length <= 8)
    return refused(task, 'assignment_changed');
  const changes = task.ownerCatId !== command.ownerCatId;
  return updated({
    ...task,
    ownerCatId: command.ownerCatId,
    ownerRevision: command.expected.ownerRevision + Number(changes),
    ...(changes ? { ownerChangedAt: now } : {}),
    lastAppliedHandoffMessageRef: command.messageRef,
    updatedAt: now,
  });
}

function callbackActorMatches(task: TaskItem, actor: TaskMutationActor): boolean {
  if (actor.userId !== task.userId) return false;
  const execution = task.executionRef;
  const exactExecution =
    execution &&
    execution.invocationId === actor.invocationId &&
    execution.catId === actor.catId &&
    execution.threadId === actor.threadId;
  return execution
    ? Boolean(exactExecution)
    : (task.ownerCatId === null || actor.catId === task.ownerCatId) && actor.threadId === task.threadId;
}

/** Generic owner/home mutations still advance the same version and cannot silently detach a writer. */
export function advanceOrdinaryTaskAssignment(before: TaskItem, after: TaskItem): TaskItem {
  if (!isOrdinaryImplementTask(before)) return after;
  const changed = before.ownerCatId !== after.ownerCatId || before.threadId !== after.threadId;
  if (changed && before.executionRef) throw new Error('TASK_EXECUTION_MUST_STOP_BEFORE_REASSIGNMENT');
  return {
    ...after,
    ...(before.ownerRevision !== undefined || changed
      ? { ownerRevision: (before.ownerRevision ?? 0) + Number(changed) }
      : {}),
    ...(changed ? { ownerChangedAt: after.updatedAt } : {}),
  };
}
