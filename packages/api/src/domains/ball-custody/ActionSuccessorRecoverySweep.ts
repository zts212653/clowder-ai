import { createModuleLogger } from '../../infrastructure/logger.js';
import { returnDeliveryOverdueTotal } from '../../infrastructure/telemetry/instruments.js';
import { type ActionSuccessorFence, buildActionSuccessorFence } from './ActionSuccessorAdmissionService.js';
import {
  ActionSuccessorDispatchRecovery,
  type ActionSuccessorDispatchRecoveryDeps,
  type ActionSuccessorDispatchRecoveryStats,
  type DispatchRecoveryResult,
} from './ActionSuccessorDispatchRecovery.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export {
  type ActionSuccessorDispatchDeliveryResult,
  type ActionSuccessorDispatchRecoveryStats,
  type ApprovedActionCarrierClassification,
  classifyApprovedActionCarrier,
  type DispatchRecoveryResult,
} from './ActionSuccessorDispatchRecovery.js';

const log = createModuleLogger('ball-custody/action-successor-recovery');
const DEFAULT_SCAN_LIMIT = 100;

export interface ActionSuccessorReturnCarrier {
  readonly threadId: string;
  readonly userId: string;
  readonly targetCatId: string;
  readonly callerCatId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly fence: ActionSuccessorFence;
}

export interface ActionSuccessorRecoveryStats {
  readonly scanned: number;
  readonly delivered: number;
  readonly pending: number;
  readonly overdue: number;
}

export type ActionSuccessorReturnDeliveryResult =
  | { readonly outcome: 'completed'; readonly invocationId: string }
  | { readonly outcome: 'enqueued' | 'unavailable' };

export interface ActionSuccessorRecoverySweepDeps {
  readonly leaseStore: Pick<
    ActionSuccessorLeaseStore,
    'listPendingReturns' | 'recordReturnDeliveryAttempt' | 'markReturnDelivered'
  >;
  readonly deliverReturnCarrier: (
    carrier: ActionSuccessorReturnCarrier,
  ) => Promise<ActionSuccessorReturnDeliveryResult>;
  readonly now?: () => number;
  readonly scanLimit?: number;
  readonly onOverdue?: (input: {
    leaseId: string;
    generation: number;
    threadId: string;
    catId: string;
    slaUntil: number;
  }) => void;
  readonly dispatch?: Omit<ActionSuccessorDispatchRecoveryDeps, 'now' | 'scanLimit'>;
}

interface ReturnRecoveryResult {
  readonly outcome: 'ignored' | 'delivered' | 'pending';
  readonly overdue: boolean;
}

function carrierFor(lease: ActionSuccessorLease): ActionSuccessorReturnCarrier {
  const targetCatId = lease.holderCatIds[0];
  if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !targetCatId || !lease.predecessorCatId) {
    throw new Error(`invalid pending ActionSuccessor return route: ${lease.leaseId}`);
  }
  const idempotencyKey = `action-return:${lease.leaseId}:${lease.generation}:${targetCatId}`;
  return {
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    targetCatId,
    callerCatId: lease.predecessorCatId,
    content: `[ActionSuccessor return recovery]\nlease=${lease.leaseId} generation=${lease.generation} subject=${lease.subjectRef}`,
    idempotencyKey,
    fence: buildActionSuccessorFence(lease, lease.dispatchId),
  };
}

export class ActionSuccessorRecoverySweep {
  private readonly now: () => number;
  private readonly scanLimit: number;
  private readonly dispatchRecovery?: ActionSuccessorDispatchRecovery;

  constructor(private readonly deps: ActionSuccessorRecoverySweepDeps) {
    this.now = deps.now ?? Date.now;
    this.scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
    if (deps.dispatch) {
      this.dispatchRecovery = new ActionSuccessorDispatchRecovery({
        ...deps.dispatch,
        now: this.now,
        scanLimit: this.scanLimit,
      });
    }
  }

  async runOnce(): Promise<ActionSuccessorRecoveryStats> {
    const leases = await this.deps.leaseStore.listPendingReturns(this.scanLimit);
    let delivered = 0;
    let pending = 0;
    let overdue = 0;

    for (const candidate of leases) {
      const result = await this.recoverLease(candidate);
      if (result.overdue) overdue += 1;
      if (result.outcome === 'delivered') delivered += 1;
      if (result.outcome === 'pending') pending += 1;
    }
    return { scanned: leases.length, delivered, pending, overdue };
  }

  async runDispatchesOnce(): Promise<ActionSuccessorDispatchRecoveryStats> {
    return this.dispatchRecovery?.runOnce() ?? { scanned: 0, delivered: 0, pending: 0, failed: 0 };
  }

  async recoverDispatch(candidate: ActionSuccessorLease): Promise<DispatchRecoveryResult> {
    if (!this.dispatchRecovery) throw new Error('ActionSuccessor dispatch recovery is not configured');
    return this.dispatchRecovery.recover(candidate);
  }

  private async recoverLease(candidate: ActionSuccessorLease): Promise<ReturnRecoveryResult> {
    const now = this.now();
    const attempt = await this.deps.leaseStore.recordReturnDeliveryAttempt(candidate.leaseId, {
      expectedGeneration: candidate.generation,
      now,
    });
    if (attempt.outcome !== 'recorded') return { outcome: 'ignored', overdue: false };
    const lease = attempt.lease;
    this.observeOverdueTransition(lease, attempt.becameOverdue === true, now);

    const carrier = carrierFor(lease);
    let delivery: ActionSuccessorReturnDeliveryResult = { outcome: 'unavailable' };
    try {
      delivery = await this.deps.deliverReturnCarrier(carrier);
    } catch (err) {
      log.warn(
        { err, leaseId: lease.leaseId, generation: lease.generation },
        'F167 S.1-c ActionSuccessor return carrier delivery failed',
      );
    }
    if (delivery.outcome !== 'completed') {
      return { outcome: 'pending', overdue: lease.returnDeliveryState === 'overdue' };
    }

    const result = await this.deps.leaseStore.markReturnDelivered(lease.leaseId, {
      expectedGeneration: lease.generation,
      evidenceRef: `invocation:${delivery.invocationId}`,
      now,
    });
    const delivered = result.outcome === 'delivered' || result.outcome === 'return_not_pending';
    return { outcome: delivered ? 'delivered' : 'pending', overdue: lease.returnDeliveryState === 'overdue' };
  }

  private observeOverdueTransition(lease: ActionSuccessorLease, becameOverdue: boolean, now: number): void {
    if (!becameOverdue) return;
    returnDeliveryOverdueTotal.add(1);
    const observation = {
      leaseId: lease.leaseId,
      generation: lease.generation,
      threadId: lease.holderThreadId,
      catId: lease.holderCatIds[0] ?? 'unknown',
      slaUntil: lease.returnDeliverySlaUntil ?? now,
    };
    this.deps.onOverdue?.(observation);
    log.warn(observation, 'F167 S.1-c ActionSuccessor return delivery exceeded SLA');
  }
}
