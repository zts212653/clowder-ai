import { isDeepStrictEqual } from 'node:util';
import { createWaitContinuationCarrier, type DeploymentWaitStateV1, type TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { deploymentWaitGeneration } from '../cats/services/stores/ports/TaskDeploymentWaitState.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { renderOutcome } from './DeploymentWaitOutcome.js';
import { deploymentTransportAttempt } from './DeploymentWaitPublicationIdentity.js';

export type CurrentTurnClaimDisposition = 'active' | 'unknown' | 'succeeded' | 'recover';
type Claim = NonNullable<DeploymentWaitStateV1['currentExecutionClaim']>;
type Receipt = NonNullable<DeploymentWaitStateV1['currentExecutionReceipt']>;
type Release = 'succeeded' | 'recover' | 'release';
type ReceiptProof = { readonly verified: false } | { readonly verified: true; readonly receipt?: Receipt };
const MAX_WRITE_ATTEMPTS = 3;

function matchesReceipt(message: StoredMessage, task: TaskItem, claim: Claim): boolean {
  const outcome = task.deploymentWait?.waitOutcome;
  return (
    !!outcome &&
    message.userId === task.userId &&
    message.threadId === task.threadId &&
    message.content === renderOutcome(outcome) &&
    isDeepStrictEqual(message.source?.meta?.currentExecutionClaim, claim) &&
    isDeepStrictEqual(message.source?.meta?.waitContinuationCarrier, createWaitContinuationCarrier(task.id, outcome))
  );
}

function releasedState(
  taskId: string,
  state: DeploymentWaitStateV1,
  claim: Claim,
  disposition: Release,
  receipt?: Receipt,
): DeploymentWaitStateV1 {
  const { currentExecutionClaim: _released, ...next } = state;
  const outcome = state.waitOutcome;
  const retained = { ...next, ...(receipt ? { currentExecutionReceipt: receipt } : {}) };
  if (disposition === 'recover') {
    return {
      ...retained,
      recoverySource: claim,
      ...(outcome?.reason === 'matched'
        ? {
            waitOutcome: { ...outcome, delivery: 'pending' },
            transportAttempt: state.transportAttempt ?? deploymentTransportAttempt(taskId, outcome.outcomeId, claim),
          }
        : {}),
    };
  }
  return disposition === 'succeeded' && outcome?.reason === 'matched'
    ? { ...retained, waitOutcome: { ...outcome, delivery: 'delivered' } }
    : retained;
}

/** A registration callback owns its immediate match until the exact child has terminal truth. */
export class DeploymentWaitCurrentTurnClaim {
  constructor(
    private readonly options: {
      readonly taskStore: Pick<ITaskStore, 'get' | 'replaceDeploymentWaitIfGeneration'>;
      readonly bootId?: string;
      readonly turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
      readonly messageStore?: Pick<IMessageStore, 'getByIdempotencyKey'>;
    },
  ) {}

  async disposition(claim: Claim, task: TaskItem): Promise<CurrentTurnClaimDisposition> {
    try {
      const child = await this.options.turnExecutionStore?.get(claim.invocationId);
      if (
        !child ||
        child.invocationId !== claim.invocationId ||
        child.threadId !== task.threadId ||
        child.userId !== task.userId ||
        child.catId !== task.ownerCatId
      )
        return 'unknown';
      if (child.status === 'running') return 'active';
      if (child.status === 'succeeded') return 'succeeded';
      return ['failed', 'canceled', 'interrupted'].includes(child.status) ? 'recover' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async release(taskId: string, invocationId: string, disposition: Release = 'release'): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const task = await this.options.taskStore.get(taskId);
      const state = task?.deploymentWait;
      if (!task || state?.currentExecutionClaim?.invocationId !== invocationId) return true;
      const claim = state.currentExecutionClaim;
      if (!(await this.canRelease(task, claim, disposition))) return false;
      const proof = await this.receiptProof(task, claim);
      if (!proof.verified) return false;
      const next = releasedState(taskId, state, claim, disposition, proof.receipt);
      if (
        await this.options.taskStore.replaceDeploymentWaitIfGeneration(taskId, {
          expectedGeneration: deploymentWaitGeneration(state),
          expectedDeploymentWait: state,
          expectedUpdatedAt: task.updatedAt,
          deploymentWait: next,
        })
      )
        return true;
    }
    return false;
  }

  private async canRelease(task: TaskItem, claim: Claim, requested: Release): Promise<boolean> {
    const outcome = task.deploymentWait?.waitOutcome;
    // Callback finally releases a non-match, never a matched notice with uncertain effects.
    if (requested === 'release') return outcome?.reason !== 'matched';
    if ((await this.disposition(claim, task)) !== requested) return false;
    // Legacy matched claims do not prove whether old History acquired Queue custody.
    return requested !== 'recover' || outcome?.reason !== 'matched' || !!task.deploymentWait?.currentExecutionReceipt;
  }

  private async receiptProof(task: TaskItem, claim: Claim): Promise<ReceiptProof> {
    const receipt = task.deploymentWait?.currentExecutionReceipt;
    if (!receipt || receipt.messageId) return { verified: true, ...(receipt ? { receipt } : {}) };
    if (!this.options.messageStore || !task.userId) return { verified: false };
    try {
      const message = await this.options.messageStore.getByIdempotencyKey(
        task.userId,
        task.threadId,
        receipt.notificationKey,
      );
      if (!message) return { verified: true, receipt }; // Definitive absence, not a failed read.
      if (!matchesReceipt(message, task, claim)) return { verified: false };
      return { verified: true, receipt: { ...receipt, messageId: message.id } };
    } catch {
      return { verified: false };
    } // Unknown History commit retains its claim.
  }
}
