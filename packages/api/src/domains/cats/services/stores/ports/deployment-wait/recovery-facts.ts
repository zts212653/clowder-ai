import type { TaskItem, WaitTerminationEventV1 } from '@cat-cafe/shared';
import type { TypedWaitRegistration } from '../../../../../ball-custody/TypedWaitRegistration.js';
import { lifecycleEvent } from '../../../../../runtime-deployment/DeploymentWaitOutcome.js';
import { isDeploymentWaitProjectionCandidate } from './live-candidate.js';

export interface DeploymentWaitAudit {
  taskId: string;
  event: WaitTerminationEventV1;
  token: string;
  failures: number;
  nextAt: number;
  disposition?: 'needs_attention';
  reasonCode?: string;
}

export interface DeploymentRecoveryFacts {
  capturedOutcomeId?: string;
  pending: Record<string, DeploymentWaitAudit>;
  live?: { signature: string; failures: number; nextAt: number; disposition?: 'needs_attention' };
}

/** Original Task-owner metadata: pending exact events survive replacement of the business wait/receipt. */
export function reconcileDeploymentRecoveryFacts(
  previous: TaskItem | undefined,
  task: TaskItem,
  receipt: TypedWaitRegistration | null,
  current?: DeploymentRecoveryFacts,
): DeploymentRecoveryFacts {
  const facts = structuredClone(current ?? { pending: {} });
  for (const candidate of [previous, task]) {
    const outcome = candidate?.deploymentWait?.waitOutcome;
    if (!candidate || !outcome || facts.capturedOutcomeId === outcome.outcomeId) continue;
    const event = lifecycleEvent(candidate, outcome);
    let knownOwner = Boolean(event.ownerUserId && event.ownerCatId && event.threadId);
    const needsOriginal = outcome.reason === 'owner_changed' || outcome.reason === 'subject_terminal';
    if (needsOriginal) knownOwner = false;
    if (
      receipt?.proofKind === 'deployment_predicate' &&
      receipt.taskId === task.id &&
      receipt.subjectRef === outcome.subjectRef &&
      receipt.generation === outcome.generation
    ) {
      event.ownerUserId = receipt.userId;
      event.ownerCatId = receipt.catId;
      event.threadId = receipt.threadId;
      knownOwner = true;
    } else if (needsOriginal && candidate === task) {
      const origin =
        previous?.deploymentWait?.await ??
        (previous?.deploymentWait?.waitOutcome?.reason === 'matched' ? previous.deploymentWait.waitOutcome : null);
      if (
        origin?.generation === outcome.generation &&
        origin.subjectRef === outcome.subjectRef &&
        previous?.ownerCatId &&
        previous.userId &&
        previous.threadId
      ) {
        event.ownerUserId = previous.userId;
        event.ownerCatId = previous.ownerCatId;
        event.threadId = previous.threadId;
        knownOwner = true;
      }
    }
    if (!knownOwner) event.ownerCatId = '';
    if (!facts.pending[event.eventId])
      facts.pending[event.eventId] = {
        taskId: task.id,
        event,
        token: JSON.stringify(event),
        failures: 0,
        nextAt: outcome.at,
        ...(!knownOwner ? { disposition: 'needs_attention' as const, reasonCode: 'original_wait_owner_unknown' } : {}),
      };
    facts.capturedOutcomeId = outcome.outcomeId;
  }
  if (isDeploymentWaitProjectionCandidate(task)) {
    const signature = JSON.stringify(task.deploymentWait);
    if (facts.live?.signature !== signature) facts.live = { signature, failures: 0, nextAt: task.updatedAt };
  } else delete facts.live;
  return facts;
}

export function nextDeploymentAuditAt(facts: DeploymentRecoveryFacts): number | undefined {
  const times = Object.values(facts.pending)
    .filter((entry) => !entry.disposition)
    .map((entry) => entry.nextAt);
  return times.length ? Math.min(...times) : undefined;
}
