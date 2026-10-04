import { isDeepStrictEqual } from 'node:util';
import type { DeploymentWaitStateV1, TaskItem } from '@cat-cafe/shared';
import type { ReplaceDeploymentWaitIfGenerationInput } from './TaskStoreContract.js';

export function deploymentWaitGeneration(state: DeploymentWaitStateV1 | undefined): number | null {
  return state?.await?.generation ?? state?.waitOutcome?.generation ?? null;
}

function sameDeploymentWaitState(
  current: DeploymentWaitStateV1 | undefined,
  expected: DeploymentWaitStateV1 | undefined,
): boolean {
  return isDeepStrictEqual(current, expected);
}

export function deploymentWaitReplacementMatches(
  existing: TaskItem,
  input: ReplaceDeploymentWaitIfGenerationInput,
): boolean {
  return (
    (input.expectedUpdatedAt === undefined || existing.updatedAt === input.expectedUpdatedAt) &&
    deploymentWaitGeneration(existing.deploymentWait) === input.expectedGeneration &&
    sameDeploymentWaitState(existing.deploymentWait, input.expectedDeploymentWait)
  );
}

/** A custody or terminal Task write consumes its armed deployment wait in the same aggregate write. */
export function reconcileDeploymentWaitTaskMutation(previous: TaskItem, next: TaskItem): TaskItem {
  const active = previous.deploymentWait?.await;
  // An admitted message may still be retried. Terminal work and owner changes
  // must revoke that authority in the same Task write, even after delivery.
  const matched =
    previous.deploymentWait?.waitOutcome?.reason === 'matched' ? previous.deploymentWait.waitOutcome : undefined;
  const current = active ?? matched;
  if (!current) return next;
  const ownerChanged = next.ownerCatId !== previous.ownerCatId || next.threadId !== previous.threadId;
  const terminal =
    next.status === 'done' || (next.entrustedWork !== undefined && next.entrustedWork.closure.state !== 'open');
  if (!ownerChanged && !terminal) return next;

  const reason = terminal ? 'subject_terminal' : 'owner_changed';
  const nextStep = active ? active.continuation.then : matched?.nextStep;
  return {
    ...next,
    deploymentWait: {
      waitOutcome: {
        v: 1,
        domain: 'deployment',
        outcomeId: `wait:${current.subjectRef}:g${current.generation}:${reason}`,
        generation: current.generation,
        subjectRef: current.subjectRef,
        ownerFence: current.ownerFence,
        reason,
        at: next.updatedAt,
        registeredAt: active?.createdAt ?? matched?.registeredAt,
        delivery: 'not_applicable',
        ...(nextStep ? { nextStep } : {}),
        actor: { kind: 'system' },
      },
    },
  };
}

function assertState(state: DeploymentWaitStateV1 | undefined): void {
  if (!state) return;
  const active = state.await;
  const outcome = state.waitOutcome;
  const claim = state.currentExecutionClaim;
  if (claim && (!claim.invocationId || !claim.bootId || claim.generation !== deploymentWaitGeneration(state))) {
    throw new Error('current execution claim must bind the exact deployment wait generation');
  }
  if (active) {
    if (!active.subjectRef.startsWith('deployment:') || active.autoRenew !== false) {
      throw new Error('work Task deployment wait requires one single-fire deployment await');
    }
    if (active.ownerFence.kind !== 'containing_task' || active.ownerFence.generation !== active.generation) {
      throw new Error('deployment wait owner fence must bind its containing Task generation');
    }
  }
  if (outcome) {
    if (outcome.domain !== 'deployment' || !outcome.subjectRef.startsWith('deployment:')) {
      throw new Error('deployment wait outcome must retain its bounded deployment domain');
    }
    if (outcome.ownerFence.kind !== 'containing_task' || outcome.ownerFence.generation !== outcome.generation) {
      throw new Error('deployment wait outcome fence must bind its containing Task generation');
    }
  }
}

export function buildTaskDeploymentWaitReplacement(
  existing: TaskItem,
  input: ReplaceDeploymentWaitIfGenerationInput,
): TaskItem {
  if (existing.kind !== 'work') throw new Error('deployment waits belong to original work Tasks');
  if (!existing.userId || !existing.ownerCatId) {
    throw new Error('deployment wait requires a canonical Task user and owner');
  }
  if (existing.status === 'done' || (existing.entrustedWork && existing.entrustedWork.closure.state !== 'open')) {
    throw new Error('terminal work cannot register or advance a deployment wait');
  }
  assertState(input.deploymentWait);
  return {
    ...existing,
    deploymentWait: input.deploymentWait,
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: Date.now(),
  };
}
