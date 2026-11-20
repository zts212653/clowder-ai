import { parseWaitContinuationCarrier, type TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { ordinaryTaskExpectation, type TaskMutationActor } from '../cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../cats/services/stores/ports/TaskStoreContract.js';
import { MessageKeys } from '../cats/services/stores/redis-keys/message-keys.js';
import { receiptOwnsOutcome } from '../runtime-deployment/DeploymentWaitAuthority.js';
import { OrdinaryTaskHandoffError } from './OrdinaryTaskHandoffContract.js';
import { typedWaitPredicateDigest } from './TypedWaitRegistration.js';

export function hasOutstandingDeploymentWait(task: TaskItem): boolean {
  return Boolean(
    task.deploymentWait?.await ||
      (task.deploymentWait?.waitOutcome?.reason === 'matched' &&
        task.deploymentWait.waitOutcome.delivery === 'pending'),
  );
}

export async function retainedDeploymentWaitAllowsHandoff(
  task: TaskItem,
  tasks: Pick<ITaskStore, 'getWaitRegistration'>,
  messages: Pick<IMessageStore, 'getById'>,
): Promise<boolean> {
  const read = await tasks.getWaitRegistration(task.id);
  const receipt = read?.receipt;
  const wait = read?.task.deploymentWait;
  if (
    !receipt ||
    !wait ||
    wait.currentExecutionClaim ||
    receipt.taskId !== task.id ||
    receipt.taskKind !== 'work' ||
    receipt.userId !== task.userId ||
    receipt.catId !== task.ownerCatId ||
    receipt.threadId !== task.threadId ||
    receipt.proofKind !== 'deployment_predicate'
  )
    return false;
  if (wait.transportAttempt) {
    const delivered = wait.transportAttempt.messageId ? await messages.getById(wait.transportAttempt.messageId) : null;
    if (
      wait.waitOutcome?.delivery !== 'delivered' ||
      !delivered ||
      delivered.deliveryStatus === 'canceled' ||
      !delivered.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === task.ownerCatId && ref.phase === 'settled')
    )
      return false;
  }
  if (wait.await) {
    const active = wait.await;
    if (
      active.ownerFence.kind !== 'containing_task' ||
      active.ownerFence.generation !== active.generation ||
      active.generation !== receipt.generation ||
      receipt.ownerFence.generation !== receipt.generation ||
      active.subjectRef !== receipt.subjectRef ||
      typedWaitPredicateDigest(active) !== receipt.predicateDigest
    )
      return false;
  } else if (!wait.waitOutcome || !receiptOwnsOutcome(read.task, wait.waitOutcome, receipt, true)) return false;
  const origin = await messages.getById(receipt.source.sourceMessageId);
  return Boolean(
    origin &&
      origin.userId === task.userId &&
      origin.threadId === task.threadId &&
      !origin.deletedAt &&
      !origin.recall &&
      !origin._tombstone &&
      origin.deliveryStatus !== 'canceled',
  );
}

/** Bind the deployment continuation at the provider boundary through the same Task writer CAS. */
export async function bindOrdinaryDeploymentWake(
  deps: {
    tasks: ITaskStore;
    messages: Pick<IMessageStore, 'getById'>;
  },
  message: StoredMessage,
  actor: TaskMutationActor,
  parentInvocationId: string,
): Promise<string | undefined> {
  if (message.source?.connector !== 'deployment-wait') return undefined;
  const carrier = parseWaitContinuationCarrier(message.source.meta?.waitContinuationCarrier);
  if (!carrier) throw new OrdinaryTaskHandoffError('task_deployment_wake_invalid');
  const read = await deps.tasks.getWaitRegistration(carrier.waitId);
  if (read?.task && !isOrdinaryImplementTask(read.task)) return undefined;
  const assignedHandoff = message.source.meta?.taskHandoffRef ?? null;
  const check = async () => {
    const snapshot = await deps.tasks.getWaitRegistration(carrier.waitId);
    const task = snapshot?.task;
    const outcome = task?.deploymentWait?.waitOutcome;
    const carrierMessage = await deps.messages.getById(message.id);
    if (
      !snapshot ||
      !task ||
      !outcome ||
      !carrierMessage ||
      !isOrdinaryImplementTask(task) ||
      task.userId !== actor.userId ||
      task.threadId !== actor.threadId ||
      task.ownerCatId !== actor.catId ||
      message.threadId !== task.threadId ||
      message.userId !== task.userId ||
      !message.mentions.includes(task.ownerCatId) ||
      carrierMessage.deletedAt ||
      carrierMessage.recall ||
      carrierMessage._tombstone ||
      carrierMessage.deliveryStatus === 'canceled' ||
      task.deploymentWait?.currentExecutionClaim ||
      (task.lastAppliedHandoffMessageRef ?? null) !== assignedHandoff ||
      (task.deploymentWait?.transportAttempt?.taskHandoffRef ?? null) !== assignedHandoff ||
      (task.deploymentWait?.transportAttempt?.messageId &&
        task.deploymentWait.transportAttempt.messageId !== message.id) ||
      outcome.outcomeId !== carrier.outcomeId ||
      outcome.generation !== carrier.ownerFence.generation ||
      !receiptOwnsOutcome(task, outcome, snapshot.receipt, true)
    )
      throw new OrdinaryTaskHandoffError('task_deployment_wake_assignment_changed');
    return task;
  };
  const task = await check();
  const result = await deps.tasks.mutateOrdinaryTask(
    {
      kind: 'bind_deployment_execution',
      taskId: task.id,
      expected: ordinaryTaskExpectation(task),
      execution: {
        invocationId: actor.invocationId,
        parentInvocationId,
        catId: actor.catId,
        threadId: actor.threadId,
        sourceMessageId: message.id,
      },
    },
    {
      watchKeys: [MessageKeys.detail(message.id)],
      assertCurrent: async () => {
        await check();
      },
    },
  );
  if (result.kind !== 'updated' && result.kind !== 'replayed')
    throw new OrdinaryTaskHandoffError('task_deployment_wake_assignment_changed');
  return task.id;
}
