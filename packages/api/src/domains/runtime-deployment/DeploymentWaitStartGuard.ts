import {
  type DeploymentWaitOutcomeV1,
  deploymentOutcomeMatchesObservation,
  parseWaitContinuationCarrier,
  type TaskItem,
  type WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import type { DeploymentObservationProvider } from '../../routes/callback-deployment-wait-routes.js';
import type { TypedWaitRegistration } from '../ball-custody/TypedWaitRegistration.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { deploymentWaitGeneration } from '../cats/services/stores/ports/TaskDeploymentWaitState.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { receiptOwnsOutcome } from './DeploymentWaitAuthority.js';

export interface DeploymentWaitStartIdentity {
  readonly messageId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly expectedWaitCarrier?: boolean;
  readonly expectedDeploymentWait?: boolean;
}

export type DeploymentWaitStartDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'authority_stale' | 'evidence_stale' };

/** A missing runtime authority must not turn a persisted deployment wake into ordinary connector work. */
export async function checkDeploymentWaitStart(
  input: DeploymentWaitStartIdentity,
  deps: {
    readonly guard?: Pick<DeploymentWaitStartGuard, 'check'>;
    readonly messageStore?: Pick<IMessageStore, 'getById'>;
  },
): Promise<DeploymentWaitStartDecision> {
  if (deps.guard) return deps.guard.check(input);
  if (input.expectedDeploymentWait) return { ok: false, reason: 'evidence_stale' };
  if (!deps.messageStore) {
    return input.expectedWaitCarrier ? { ok: false, reason: 'authority_stale' } : { ok: true };
  }
  const message = await deps.messageStore.getById(input.messageId);
  if (message?.source?.connector === 'deployment-wait') return { ok: false, reason: 'evidence_stale' };
  if (input.expectedWaitCarrier && message?.source?.connector !== 'github-wait') {
    return { ok: false, reason: 'authority_stale' };
  }
  return { ok: true };
}

/** Rechecks the canonical Task and current deployment at the execution boundary. */
export class DeploymentWaitStartGuard {
  constructor(
    private readonly deps: {
      readonly taskStore: Pick<ITaskStore, 'getWaitRegistration' | 'replaceDeploymentWaitIfGeneration'>;
      readonly messageStore: Pick<IMessageStore, 'getById'>;
      readonly observationProvider: DeploymentObservationProvider;
    },
  ) {}

  async canStart(input: DeploymentWaitStartIdentity): Promise<boolean> {
    return (await this.check(input)).ok;
  }

  async check(input: DeploymentWaitStartIdentity): Promise<DeploymentWaitStartDecision> {
    const message = await this.deps.messageStore.getById(input.messageId);
    if (!message)
      return input.expectedWaitCarrier || input.expectedDeploymentWait
        ? { ok: false, reason: 'authority_stale' }
        : { ok: true };
    if (message.source?.connector !== 'deployment-wait') {
      return input.expectedDeploymentWait || (input.expectedWaitCarrier && message.source?.connector !== 'github-wait')
        ? { ok: false, reason: 'authority_stale' }
        : { ok: true };
    }
    if (message.threadId !== input.threadId || message.userId !== input.userId || message.catId !== null) {
      return { ok: false, reason: 'authority_stale' };
    }
    const carrier = parseWaitContinuationCarrier(message.source.meta?.waitContinuationCarrier);
    if (!carrier || carrier.ownerFence.kind !== 'containing_task') return { ok: false, reason: 'authority_stale' };
    const snapshot = await this.deps.taskStore.getWaitRegistration(carrier.waitId);
    const task = snapshot?.task;
    const outcome = task?.deploymentWait?.waitOutcome;
    if (!task || !outcome || !this.authorized(input, task, outcome, snapshot.receipt, carrier)) {
      return { ok: false, reason: 'authority_stale' };
    }
    const deploymentId = outcome.subjectRef.split(':')[2];
    if (!deploymentId) return { ok: false, reason: 'authority_stale' };
    const observation = await this.deps.observationProvider
      .observe({
        deploymentId,
        ...(outcome.deploymentMatch?.kind === 'revision_included' && outcome.deploymentMatch.targetRevision
          ? { targetRevision: outcome.deploymentMatch.targetRevision }
          : {}),
      })
      .catch(() => null);
    if (!observation || !deploymentOutcomeMatchesObservation(outcome, observation)) {
      const current = await this.deps.taskStore.getWaitRegistration(carrier.waitId);
      const currentOutcome = current?.task.deploymentWait?.waitOutcome;
      if (
        !current ||
        !currentOutcome ||
        !this.authorized(input, current.task, currentOutcome, current.receipt, carrier)
      ) {
        return { ok: false, reason: 'authority_stale' };
      }
      if (currentOutcome.delivery === 'delivered') {
        const state = current.task.deploymentWait;
        if (
          !state ||
          !(await this.deps.taskStore.replaceDeploymentWaitIfGeneration(current.task.id, {
            expectedGeneration: deploymentWaitGeneration(state),
            expectedDeploymentWait: state,
            expectedUpdatedAt: current.task.updatedAt,
            deploymentWait: { ...state, waitOutcome: { ...currentOutcome, delivery: 'pending' } },
          }))
        )
          return { ok: false, reason: 'authority_stale' };
      }
      return { ok: false, reason: 'evidence_stale' };
    }
    const current = await this.deps.taskStore.getWaitRegistration(carrier.waitId);
    return !!current?.task.deploymentWait?.waitOutcome &&
      this.authorized(input, current.task, current.task.deploymentWait.waitOutcome, current.receipt, carrier)
      ? { ok: true }
      : { ok: false, reason: 'authority_stale' };
  }

  private authorized(
    input: DeploymentWaitStartIdentity,
    task: TaskItem,
    outcome: DeploymentWaitOutcomeV1,
    receipt: TypedWaitRegistration | null,
    carrier: WaitContinuationCarrierV1,
  ): boolean {
    return (
      task.threadId === input.threadId &&
      task.userId === input.userId &&
      task.ownerCatId === input.catId &&
      !task.deploymentWait?.currentExecutionClaim &&
      carrier.outcomeId === outcome.outcomeId &&
      carrier.ownerFence.generation === outcome.generation &&
      receiptOwnsOutcome(task, outcome, receipt, true)
    );
  }
}
