import type { DeploymentWaitOutcomeV1, TaskItem } from '@cat-cafe/shared';
import type { TypedWaitRegistration } from '../ball-custody/TypedWaitRegistration.js';

export function isDeploymentWaitTask(task: TaskItem | null | undefined): task is TaskItem {
  return task?.kind === 'work' && !!task.userId && !!task.ownerCatId;
}

export function receiptOwnsOutcome(
  task: TaskItem,
  outcome: DeploymentWaitOutcomeV1,
  receipt: TypedWaitRegistration | null | undefined,
  acceptDelivered = false,
): boolean {
  const current = task.deploymentWait?.waitOutcome;
  return (
    task.status !== 'done' &&
    (!task.entrustedWork || task.entrustedWork.closure.state === 'open') &&
    current?.outcomeId === outcome.outcomeId &&
    current.reason === 'matched' &&
    (current.delivery === 'pending' || (acceptDelivered && current.delivery === 'delivered')) &&
    !!receipt &&
    receipt.taskId === task.id &&
    receipt.taskKind === 'work' &&
    receipt.userId === task.userId &&
    receipt.catId === task.ownerCatId &&
    receipt.threadId === task.threadId &&
    receipt.subjectRef === outcome.subjectRef &&
    receipt.generation === outcome.generation &&
    outcome.ownerFence.kind === 'containing_task' &&
    outcome.ownerFence.generation === outcome.generation &&
    receipt.ownerFence.kind === 'containing_task' &&
    receipt.ownerFence.generation === outcome.generation
  );
}
