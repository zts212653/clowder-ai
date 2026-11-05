import type { ActionSuccessorRequestMetadata } from '@cat-cafe/shared';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { OrdinaryTaskHandoffService } from '../domains/ball-custody/OrdinaryTaskHandoffService.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { TaskMutationActor } from '../domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../domains/cats/services/stores/ports/TaskStoreContract.js';

/** Classify by the actual Task, never by title, namespace guesses or a caller's authority flag. */
export async function prepareCallbackTaskHandoff(input: {
  action?: ActionSuccessorRequestMetadata;
  tasks?: Pick<ITaskStore, 'get'>;
  service?: OrdinaryTaskHandoffService;
  messages: Pick<IMessageStore, 'getByIdempotencyKey'>;
  idempotencyKey?: string;
  actor: TaskMutationActor;
  targetThreadId: string;
  targets: readonly string[];
  actorCreatedAt?: number;
}) {
  if (input.action?.actionFamily !== 'implement') return undefined;
  const id = input.action?.subjectRef.match(/^subject:task:(\S+)$/)?.[1];
  if (!id || !input.tasks) return undefined;
  const task = await input.tasks.get(id);
  if (!task || !isOrdinaryImplementTask(task)) return undefined;
  if (!input.service) throw new OrdinaryTaskHandoffError('task_handoff_unavailable');
  const action = input.action;
  if (
    !action ||
    action.mode !== 'single' ||
    input.targets.length !== 1 ||
    action.actionFamily !== 'implement' ||
    action.successorSlot !== 'implementer' ||
    action.terminalPredicate?.kind !== 'task_done' ||
    action.returnToPredecessor ||
    action.replace ||
    action.claimOrigin === 'existing_standing' ||
    !input.idempotencyKey
  )
    throw new OrdinaryTaskHandoffError('ordinary_task_requires_task_assignment');
  const version =
    action.expectedOwnerRevision ??
    (task.ownerChangedAt === undefined ||
    (input.actorCreatedAt !== undefined && input.actorCreatedAt > task.ownerChangedAt)
      ? (task.ownerRevision ?? 0)
      : undefined);
  if (version === undefined) throw new OrdinaryTaskHandoffError('expected_owner_revision_required');
  const previous = await input.messages.getByIdempotencyKey(
    input.actor.userId,
    input.targetThreadId,
    input.idempotencyKey,
  );
  if (previous) {
    const request = previous.extra?.taskHandoff;
    if (
      !request ||
      request.taskId !== id ||
      (action.expectedOwnerRevision !== undefined && request.expected.ownerRevision !== action.expectedOwnerRevision) ||
      request.targetCatId !== input.targets[0] ||
      request.targetThreadId !== input.targetThreadId ||
      request.issuer.catId !== input.actor.catId ||
      request.issuer.userId !== input.actor.userId ||
      request.issuer.threadId !== input.actor.threadId ||
      request.stopPrevious !== (action.stopPreviousExecution === true)
    )
      throw new OrdinaryTaskHandoffError('task_handoff_idempotency_conflict');
    return request;
  }
  return input.service.prepare({
    taskId: id,
    expectedOwnerRevision: version,
    actor: input.actor,
    issuerCreatedAt: input.actorCreatedAt,
    targetCatId: input.targets[0]!,
    targetThreadId: input.targetThreadId,
    stopPrevious: action.stopPreviousExecution,
  });
}
