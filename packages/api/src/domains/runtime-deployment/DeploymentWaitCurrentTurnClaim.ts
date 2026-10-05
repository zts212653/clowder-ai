import type { DeploymentWaitStateV1 } from '@cat-cafe/shared';
import { deploymentWaitGeneration } from '../cats/services/stores/ports/TaskDeploymentWaitState.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';

export type CurrentTurnClaimDisposition = 'active' | 'succeeded' | 'recover';
type Claim = NonNullable<DeploymentWaitStateV1['currentExecutionClaim']>;
const MAX_WRITE_ATTEMPTS = 3;

/** A registration callback owns its immediate match until the invocation has terminal truth. */
export class DeploymentWaitCurrentTurnClaim {
  constructor(
    private readonly options: {
      readonly taskStore: Pick<ITaskStore, 'get' | 'replaceDeploymentWaitIfGeneration'>;
      readonly bootId?: string;
      readonly turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
    },
  ) {}

  async disposition(claim: Claim): Promise<CurrentTurnClaimDisposition> {
    try {
      const status = (await this.options.turnExecutionStore?.get(claim.invocationId))?.status;
      if (status === 'succeeded') return 'succeeded';
      if (this.options.bootId && this.options.bootId !== claim.bootId) return 'recover';
      if (!status || status === 'running') return 'active';
      return 'recover';
    } catch {
      return this.options.bootId && this.options.bootId !== claim.bootId ? 'recover' : 'active';
    }
  }

  async release(
    taskId: string,
    invocationId: string,
    disposition: Exclude<CurrentTurnClaimDisposition, 'active'> | 'release' = 'release',
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const task = await this.options.taskStore.get(taskId);
      const state = task?.deploymentWait;
      if (!task || state?.currentExecutionClaim?.invocationId !== invocationId) return true;
      const outcome = state.waitOutcome;
      const delivery = disposition === 'recover' ? 'pending' : disposition === 'succeeded' ? 'delivered' : undefined;
      const next: DeploymentWaitStateV1 = {
        ...(state.await ? { await: state.await } : {}),
        ...(outcome
          ? { waitOutcome: delivery && outcome.reason === 'matched' ? { ...outcome, delivery } : outcome }
          : {}),
      };
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
}
