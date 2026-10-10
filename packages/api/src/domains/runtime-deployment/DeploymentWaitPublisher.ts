import { isDeepStrictEqual } from 'node:util';
import {
  type CatId,
  createWaitContinuationCarrier,
  type DeploymentWaitOutcomeV1,
  type DeploymentWaitStateV1,
  type TaskItem,
} from '@cat-cafe/shared';
import {
  type ConnectorDeliveryInput,
  deliverConnectorMessage,
} from '../../infrastructure/email/deliver-connector-message.js';
import { receiptOwnsOutcome } from './DeploymentWaitAuthority.js';
import { DeploymentWaitCurrentTurnClaim } from './DeploymentWaitCurrentTurnClaim.js';
import type {
  DeploymentWaitLifecycleResult,
  DeploymentWaitLifecycleServiceOptions,
} from './DeploymentWaitLifecycleService.js';
import { renderOutcome } from './DeploymentWaitOutcome.js';
import { deploymentNotificationKey, deploymentTransportAttempt } from './DeploymentWaitPublicationIdentity.js';

type Publication = { readonly current: boolean; readonly key: string };
type Ack = {
  readonly state: DeploymentWaitStateV1;
  readonly outcome: DeploymentWaitOutcomeV1;
  readonly priorMessageId?: string;
};

function acknowledgement(state: DeploymentWaitStateV1, publication: Publication, messageId: string): Ack | null {
  const outcome = state.waitOutcome;
  if (!outcome) return null;
  const delivered: DeploymentWaitOutcomeV1 = { ...outcome, delivery: 'delivered' };
  if (publication.current) {
    const receipt = state.currentExecutionReceipt;
    if (receipt?.notificationKey !== publication.key) return null;
    return {
      outcome: delivered,
      priorMessageId: receipt.messageId,
      state: { ...state, waitOutcome: delivered, currentExecutionReceipt: { ...receipt, messageId } },
    };
  }
  const attempt = state.transportAttempt;
  if (attempt?.idempotencyKey !== publication.key) return null;
  return {
    outcome: delivered,
    priorMessageId: attempt.messageId,
    state: { ...state, waitOutcome: delivered, transportAttempt: { ...attempt, messageId } },
  };
}

/** One logical outcome, separately fenced current-child History and atomic Queue transport. */
export class DeploymentWaitPublisher {
  constructor(
    private readonly opts: DeploymentWaitLifecycleServiceOptions,
    private readonly claims: DeploymentWaitCurrentTurnClaim,
    private readonly hasCurrentEvidence: (outcome: DeploymentWaitOutcomeV1) => Promise<boolean>,
  ) {}

  async publish(
    task: TaskItem,
    outcome: DeploymentWaitOutcomeV1,
    extra?: ConnectorDeliveryInput['extra'],
    wakeOwner = true,
    currentInvocationId?: string,
  ): Promise<DeploymentWaitLifecycleResult> {
    const allocated = await this.allocate(task.id, outcome, wakeOwner, currentInvocationId);
    if (!allocated?.deploymentWait || !allocated.userId || !allocated.ownerCatId) {
      this.opts.log.warn(
        { taskId: task.id, outcomeId: outcome.outcomeId },
        '[F323] deployment publication authority unverified',
      );
      return { kind: 'state_only', reason: 'authority_stale' };
    }
    const state = allocated.deploymentWait;
    const currentReceipt = !wakeOwner ? state.currentExecutionReceipt : undefined;
    const key = currentReceipt?.notificationKey ?? state.transportAttempt?.idempotencyKey;
    if (!key) return { kind: 'state_only', reason: 'publication_identity_unavailable' };
    const publication = { current: !!currentReceipt, key };
    const input: ConnectorDeliveryInput = {
      userId: allocated.userId,
      threadId: allocated.threadId,
      catId: allocated.ownerCatId,
      content: renderOutcome(outcome),
      idempotencyKey: key,
      waitContinuationCarrier: createWaitContinuationCarrier(task.id, outcome),
      source: {
        connector: 'deployment-wait',
        label: 'Deployment Wait',
        icon: 'refresh-cw',
        meta: {
          waitContinuationCarrier: createWaitContinuationCarrier(task.id, outcome),
          ...(currentReceipt
            ? {
                currentExecutionClaim: {
                  invocationId: currentReceipt.invocationId,
                  generation: currentReceipt.generation,
                  bootId: currentReceipt.bootId,
                },
              }
            : {}),
          ...(state.recoverySource ? { recoverySource: state.recoverySource } : {}),
          ...(wakeOwner && state.currentExecutionReceipt
            ? { originalNotification: state.currentExecutionReceipt }
            : {}),
        },
      },
      timestamp: outcome.at,
      ...(extra ? { extra } : {}),
    };
    const messageId = publication.current ? await this.publishHistory(input) : await this.publishQueue(input);
    if (!messageId) return { kind: 'state_only', reason: 'publication_not_admitted' };
    return this.acknowledge(task.id, outcome, publication, messageId, input.content, currentInvocationId);
  }

  private async publishHistory(input: ConnectorDeliveryInput): Promise<string | null> {
    if (!this.opts.messageStore) return null;
    const { message } = await this.opts.messageStore.appendIdempotent({
      userId: input.userId,
      threadId: input.threadId,
      from: { kind: 'external', connectorId: 'deployment-wait' },
      content: input.content,
      mentions: [input.catId as CatId],
      timestamp: input.timestamp ?? Date.now(),
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      ...(input.extra ? { extra: input.extra } : {}),
    });
    // Idempotent History append is key-based; do not accept a different old envelope.
    return message.userId === input.userId &&
      message.threadId === input.threadId &&
      message.content === input.content &&
      isDeepStrictEqual(message.source, input.source) &&
      isDeepStrictEqual(message.mentions, [input.catId])
      ? message.id
      : null;
  }

  private async publishQueue(input: ConnectorDeliveryInput): Promise<string | null> {
    const delivered = await deliverConnectorMessage(this.opts.deliveryDeps, input);
    return delivered.admitted && delivered.messageId ? delivered.messageId : null;
  }

  private async acknowledge(
    taskId: string,
    outcome: DeploymentWaitOutcomeV1,
    publication: Publication,
    messageId: string,
    content: string,
    currentInvocationId?: string,
  ): Promise<DeploymentWaitLifecycleResult> {
    // A lost CAS after publication retries the same identity, never a new attempt.
    for (let retry = 0; retry < 3; retry++) {
      const current = await this.authorized(taskId, outcome, currentInvocationId);
      if (!current?.deploymentWait) return { kind: 'state_only', reason: 'authority_stale' };
      const ack = acknowledgement(current.deploymentWait, publication, messageId);
      if (!ack) return { kind: 'state_only', reason: 'publication_identity_changed' };
      if (current.deploymentWait.waitOutcome?.delivery === 'delivered' && ack.priorMessageId === messageId)
        return { kind: 'deduped', reason: 'publication_already_acknowledged' };
      const installed = await this.opts.taskStore.replaceDeploymentWaitIfGeneration(current.id, {
        expectedGeneration: outcome.generation,
        expectedDeploymentWait: current.deploymentWait,
        expectedUpdatedAt: current.updatedAt,
        deploymentWait: ack.state,
        status: 'blocked',
      });
      if (installed) return { kind: 'notified', task: installed, outcome: ack.outcome, messageId, content };
    }
    return { kind: 'state_only', reason: 'publication_acknowledgement_pending' };
  }

  private async authorized(
    taskId: string,
    outcome: DeploymentWaitOutcomeV1,
    currentInvocationId?: string,
  ): Promise<TaskItem | null> {
    const snapshot = await this.opts.taskStore.getWaitRegistration(taskId);
    if (
      !snapshot ||
      !receiptOwnsOutcome(snapshot.task, outcome, snapshot.receipt, true) ||
      !(await this.hasCurrentEvidence(outcome))
    )
      return null;
    const claim = snapshot.task.deploymentWait?.currentExecutionClaim;
    return claim && claim.invocationId !== currentInvocationId ? null : snapshot.task;
  }

  private async nextIdentity(
    task: TaskItem,
    state: DeploymentWaitStateV1,
    outcome: DeploymentWaitOutcomeV1,
    wakeOwner: boolean,
    currentInvocationId?: string,
  ): Promise<DeploymentWaitStateV1 | null> {
    if (wakeOwner) {
      if (state.currentExecutionClaim) return null;
      if (state.transportAttempt) return state.transportAttempt.outcomeId === outcome.outcomeId ? state : null;
      return {
        ...state,
        transportAttempt: deploymentTransportAttempt(task.id, outcome.outcomeId, state.recoverySource),
      };
    }
    const claim = state.currentExecutionClaim;
    if (
      !claim ||
      claim.invocationId !== currentInvocationId ||
      (await this.claims.disposition(claim, task)) !== 'active'
    )
      return null;
    if (state.currentExecutionReceipt)
      return state.currentExecutionReceipt.outcomeId === outcome.outcomeId ? state : null;
    return {
      ...state,
      currentExecutionReceipt: {
        ...claim,
        outcomeId: outcome.outcomeId,
        notificationKey: `${deploymentNotificationKey(task.id, outcome.outcomeId)}:current:${encodeURIComponent(claim.invocationId)}`,
      },
    };
  }

  private async allocate(
    taskId: string,
    outcome: DeploymentWaitOutcomeV1,
    wakeOwner: boolean,
    currentInvocationId?: string,
  ): Promise<TaskItem | null> {
    for (let retry = 0; retry < 3; retry++) {
      const task = await this.authorized(taskId, outcome, currentInvocationId);
      if (!task?.deploymentWait) return null;
      const next = await this.nextIdentity(task, task.deploymentWait, outcome, wakeOwner, currentInvocationId);
      if (!next) return null;
      if (next === task.deploymentWait) return task;
      const installed = await this.opts.taskStore.replaceDeploymentWaitIfGeneration(taskId, {
        expectedGeneration: outcome.generation,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: next,
      });
      if (installed) return installed;
    }
    return null;
  }
}
