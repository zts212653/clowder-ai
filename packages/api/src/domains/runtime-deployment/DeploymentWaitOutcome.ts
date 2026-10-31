import type {
  DeploymentWaitOutcomeV1,
  DeploymentWaitStateV1,
  TaskItem,
  WaitTerminationEventV1,
} from '@cat-cafe/shared';

export function matchedOutcomeId(subjectRef: string, generation: number): string {
  return `wait:${subjectRef}:g${generation}:matched`;
}

export function originalRegistration(current: NonNullable<DeploymentWaitStateV1['await']> | DeploymentWaitOutcomeV1): {
  readonly registeredAt?: number;
} {
  const registeredAt = 'createdAt' in current ? current.createdAt : current.registeredAt;
  return registeredAt === undefined ? {} : { registeredAt };
}

export function renderOutcome(outcome: DeploymentWaitOutcomeV1): string {
  const evidence = outcome.deploymentMatch;
  const revision = evidence?.runningRevision
    ? `running revision ${evidence.runningRevision}`
    : 'running revision unknown';
  return [
    `🔔 **Deployment ready** — ${outcome.subjectRef}`,
    '',
    `Observed boot ${evidence?.bootId ?? 'unknown'} (sequence ${evidence?.bootSequence ?? 'unknown'}), ${revision}.`,
    outcome.nextStep ? `Next: ${outcome.nextStep}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function lifecycleEvent(task: TaskItem, outcome: DeploymentWaitOutcomeV1): WaitTerminationEventV1 {
  return {
    v: 1,
    eventId: `${task.id}:${outcome.outcomeId}`,
    kind: 'wait.terminated',
    waitId: task.id,
    waitKind: 'deployment',
    subjectRef: outcome.subjectRef,
    threadId: task.threadId,
    ownerUserId: task.userId ?? '',
    ownerCatId: task.ownerCatId ?? '',
    generation: outcome.generation,
    reason: outcome.reason,
    actor: outcome.actor ?? { kind: 'system' },
    at: outcome.at,
  };
}
