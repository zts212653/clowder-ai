import type { DeploymentWaitStateV1 } from '@cat-cafe/shared';

export function deploymentNotificationKey(taskId: string, outcomeId: string): string {
  return `deployment-wait:${taskId}:${outcomeId}`;
}

/** Stable across sweeps, boots, concurrent workers and lost publication acknowledgements. */
export function deploymentTransportAttempt(
  taskId: string,
  outcomeId: string,
  recoverySource?: DeploymentWaitStateV1['recoverySource'],
  taskHandoffRef?: string | null,
): NonNullable<DeploymentWaitStateV1['transportAttempt']> {
  const original = deploymentNotificationKey(taskId, outcomeId);
  return {
    outcomeId,
    ...(taskHandoffRef ? { taskHandoffRef } : {}),
    idempotencyKey:
      original +
      (recoverySource ? `:recovery:${encodeURIComponent(recoverySource.invocationId)}` : '') +
      (taskHandoffRef ? `:assignment:${encodeURIComponent(taskHandoffRef)}` : ''),
  };
}
