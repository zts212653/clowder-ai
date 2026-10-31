import type { DeploymentWaitStateV1 } from '@cat-cafe/shared';

export function deploymentNotificationKey(taskId: string, outcomeId: string): string {
  return `deployment-wait:${taskId}:${outcomeId}`;
}

/** Stable across sweeps, boots, concurrent workers and lost publication acknowledgements. */
export function deploymentTransportAttempt(
  taskId: string,
  outcomeId: string,
  recoverySource?: DeploymentWaitStateV1['recoverySource'],
): NonNullable<DeploymentWaitStateV1['transportAttempt']> {
  const original = deploymentNotificationKey(taskId, outcomeId);
  return {
    outcomeId,
    idempotencyKey: recoverySource
      ? `${original}:recovery:${encodeURIComponent(recoverySource.invocationId)}`
      : original,
  };
}
