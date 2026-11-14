import type { TaskItem } from '@cat-cafe/shared';

/** Live wait/claim or an unacknowledged outcome; settled wait history cannot grow this projection. */
export function isDeploymentWaitProjectionCandidate(task: TaskItem): boolean {
  if (task.kind !== 'work' || task.status === 'done' || !task.ownerCatId || !task.userId) return false;
  const wait = task.deploymentWait;
  return Boolean(
    wait?.currentExecutionClaim ||
      wait?.await ||
      (wait?.waitOutcome?.reason === 'matched' && wait.waitOutcome.delivery === 'pending'),
  );
}
