import {
  type DeploymentObservationV1,
  type DeploymentWaitOutcomeV1,
  deploymentOutcomeMatchesObservation,
  evaluateDeploymentWait,
  type TaskItem,
  type WaitTerminationActor,
} from '@cat-cafe/shared';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
} from '../../infrastructure/email/deliver-connector-message.js';
import type { IWaitLifecycleEventLog } from '../ball-custody/WaitLifecycleEventLog.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { isDeploymentWaitTask } from './DeploymentWaitAuthority.js';
import { DeploymentWaitCurrentTurnClaim } from './DeploymentWaitCurrentTurnClaim.js';
import { lifecycleEvent, matchedOutcomeId, originalRegistration } from './DeploymentWaitOutcome.js';
import { DeploymentWaitPublisher } from './DeploymentWaitPublisher.js';

export interface DeploymentWaitObservation {
  readonly taskId: string;
  readonly observation: DeploymentObservationV1;
  readonly deliveryExtra?: ConnectorDeliveryInput['extra'];
  /** Registration already runs in the owner invocation; persist evidence without starting a duplicate turn. */
  readonly wakeOwner?: boolean;
  /** Exact invocation that registered this await while it is still executing. */
  readonly currentInvocationId?: string;
}

export interface DeploymentWaitNotified {
  readonly kind: 'notified';
  readonly task: TaskItem;
  readonly outcome: DeploymentWaitOutcomeV1;
  readonly messageId: string;
  readonly content: string;
}

export type DeploymentWaitLifecycleResult =
  | { readonly kind: 'not_tracked' | 'state_only' | 'deduped'; readonly reason: string }
  | DeploymentWaitNotified
  | { readonly kind: 'unrecorded'; readonly reason: 'generation_changed_concurrently' };

export interface DeploymentWaitLifecycleServiceOptions {
  readonly taskStore: ITaskStore;
  readonly messageStore?: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly eventLog?: IWaitLifecycleEventLog;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly now?: () => number;
  /** Fresh deployment truth read immediately before a matched owner message is published. */
  readonly currentObservation: (outcome: DeploymentWaitOutcomeV1) => Promise<DeploymentObservationV1 | null>;
  readonly bootId?: string;
  /** Callback invocation IDs name child TurnExecution records, not parent InvocationRecords. */
  readonly turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
}

const MAX_WRITE_ATTEMPTS = 3;

export class DeploymentWaitLifecycleService {
  private readonly now: () => number;
  private readonly currentTurnClaim: DeploymentWaitCurrentTurnClaim;
  private readonly publisher: DeploymentWaitPublisher;

  constructor(private readonly opts: DeploymentWaitLifecycleServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.currentTurnClaim = new DeploymentWaitCurrentTurnClaim(opts);
    this.publisher = new DeploymentWaitPublisher(opts, this.currentTurnClaim, (outcome) =>
      this.hasCurrentEvidence(outcome),
    );
  }

  async observe(input: DeploymentWaitObservation): Promise<DeploymentWaitLifecycleResult> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const task = await this.opts.taskStore.get(input.taskId);
      if (!isDeploymentWaitTask(task)) return { kind: 'not_tracked', reason: 'task_missing_or_unowned' };
      if (
        task.deploymentWait?.currentExecutionClaim?.invocationId !== input.currentInvocationId &&
        task.deploymentWait?.currentExecutionClaim
      ) {
        const disposition = await this.currentTurnClaim.disposition(task.deploymentWait.currentExecutionClaim, task);
        if (disposition === 'active' || disposition === 'unknown') {
          return { kind: 'state_only', reason: 'current_execution_claimed' };
        }
        if (
          !(await this.releaseCurrentExecutionClaim(
            task.id,
            task.deploymentWait.currentExecutionClaim.invocationId,
            disposition,
          ))
        ) {
          return { kind: 'state_only', reason: 'claim_release_unverified' };
        }
        continue;
      }
      const pending = task.deploymentWait?.waitOutcome;
      if (pending?.delivery === 'pending') {
        return this.publishPending(task, pending, input.deliveryExtra, input.wakeOwner, input.currentInvocationId);
      }
      const active = task.deploymentWait?.await;
      if (!active) return { kind: 'deduped', reason: 'no_active_wait' };
      const evaluation = evaluateDeploymentWait(active, input.observation);
      if (evaluation.state !== 'matched') return { kind: 'state_only', reason: evaluation.state };

      const at = input.observation.observedAt || this.now();
      const outcome: DeploymentWaitOutcomeV1 = {
        v: 1,
        domain: 'deployment',
        outcomeId: matchedOutcomeId(active.subjectRef, active.generation),
        generation: active.generation,
        subjectRef: active.subjectRef,
        ownerFence: active.ownerFence,
        reason: 'matched',
        at,
        registeredAt: active.createdAt,
        delivery: 'pending',
        deploymentMatch: evaluation.matched,
        nextStep: active.continuation.then,
        actor: { kind: 'system' },
      };
      const { await: _consumed, ...retained } = task.deploymentWait ?? {};
      const installed = await this.opts.taskStore.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: {
          ...retained,
          waitOutcome: outcome,
          ...(task.deploymentWait?.currentExecutionClaim
            ? { currentExecutionClaim: task.deploymentWait.currentExecutionClaim }
            : {}),
        },
        status: 'blocked',
      });
      if (!installed) continue;
      await this.appendLifecycleEvent(installed, outcome);
      return this.publishPending(installed, outcome, input.deliveryExtra, input.wakeOwner, input.currentInvocationId);
    }
    return { kind: 'unrecorded', reason: 'generation_changed_concurrently' };
  }

  async recoverOutcome(taskId: string): Promise<DeploymentWaitLifecycleResult> {
    const task = await this.opts.taskStore.get(taskId);
    if (!isDeploymentWaitTask(task)) return { kind: 'not_tracked', reason: 'task_missing_or_unowned' };
    const claim = task.deploymentWait?.currentExecutionClaim;
    if (claim) {
      const disposition = await this.currentTurnClaim.disposition(claim, task);
      if (disposition === 'active' || disposition === 'unknown') {
        return { kind: 'state_only', reason: 'current_execution_claimed' };
      }
      if (!(await this.releaseCurrentExecutionClaim(taskId, claim.invocationId, disposition))) {
        return { kind: 'state_only', reason: 'claim_release_unverified' };
      }
      return this.recoverOutcome(taskId);
    }
    const outcome = task.deploymentWait?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover' };
    await this.appendLifecycleEvent(task, outcome);
    return outcome.delivery === 'pending'
      ? this.publishPending(task, outcome)
      : { kind: 'state_only', reason: outcome.reason };
  }

  async cancel(
    taskId: string,
    actor: Extract<WaitTerminationActor, { kind: 'user' | 'cat' }>,
  ): Promise<DeploymentWaitLifecycleResult> {
    return this.terminalize(taskId, 'user_cancel', actor);
  }

  async ownerChanged(taskId: string): Promise<DeploymentWaitLifecycleResult> {
    return this.terminalize(taskId, 'owner_changed', { kind: 'system' });
  }

  async taskCompleted(taskId: string): Promise<DeploymentWaitLifecycleResult> {
    return this.terminalize(taskId, 'subject_terminal', { kind: 'system' });
  }

  async releaseCurrentExecutionClaim(
    taskId: string,
    invocationId: string,
    disposition: 'succeeded' | 'recover' | 'release' = 'release',
  ): Promise<boolean> {
    return this.currentTurnClaim.release(taskId, invocationId, disposition);
  }

  private async terminalize(
    taskId: string,
    reason: Extract<DeploymentWaitOutcomeV1['reason'], 'user_cancel' | 'owner_changed' | 'subject_terminal'>,
    actor: WaitTerminationActor,
  ): Promise<DeploymentWaitLifecycleResult> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!isDeploymentWaitTask(task)) return { kind: 'not_tracked', reason: 'task_missing_or_unowned' };
      const active = task.deploymentWait?.await;
      const pending = task.deploymentWait?.waitOutcome?.delivery === 'pending' ? task.deploymentWait.waitOutcome : null;
      const current = active ?? pending;
      if (!current) return { kind: 'deduped', reason: 'no_active_wait' };
      const at = this.now();
      const nextStep = 'continuation' in current ? current.continuation.then : current.nextStep;
      const outcome: DeploymentWaitOutcomeV1 = {
        v: 1,
        domain: 'deployment',
        outcomeId: `wait:${current.subjectRef}:g${current.generation}:${reason}`,
        generation: current.generation,
        subjectRef: current.subjectRef,
        ownerFence: current.ownerFence,
        reason,
        at,
        ...originalRegistration(current),
        delivery: 'not_applicable',
        ...(nextStep ? { nextStep } : {}),
        actor,
      };
      const installed = await this.opts.taskStore.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: current.generation,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: { waitOutcome: outcome },
        status: 'doing',
      });
      if (!installed) continue;
      await this.appendLifecycleEvent(installed, outcome);
      return { kind: 'state_only', reason };
    }
    return { kind: 'unrecorded', reason: 'generation_changed_concurrently' };
  }

  private async appendLifecycleEvent(task: TaskItem, outcome: DeploymentWaitOutcomeV1): Promise<void> {
    if (!this.opts.eventLog) return;
    try {
      await this.opts.eventLog.append(lifecycleEvent(task, outcome));
    } catch (error) {
      this.opts.log.warn({ error, taskId: task.id }, '[F323] deployment wait event append deferred');
    }
  }

  private async publishPending(
    task: TaskItem,
    outcome: DeploymentWaitOutcomeV1,
    deliveryExtra?: ConnectorDeliveryInput['extra'],
    wakeOwner = true,
    currentInvocationId?: string,
  ): Promise<DeploymentWaitLifecycleResult> {
    if (!(await this.hasCurrentEvidence(outcome))) return { kind: 'state_only', reason: 'deployment_evidence_stale' };
    return this.publisher.publish(task, outcome, deliveryExtra, wakeOwner, currentInvocationId);
  }

  private async hasCurrentEvidence(outcome: DeploymentWaitOutcomeV1): Promise<boolean> {
    if (outcome.reason !== 'matched') return true;
    const observation = await this.opts.currentObservation(outcome);
    return !!observation && deploymentOutcomeMatchesObservation(outcome, observation);
  }
}
