import type { DispatchProposal } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { returnDeliveryOverdueTotal } from '../../infrastructure/telemetry/instruments.js';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import { type ActionSuccessorFence, buildActionSuccessorFence } from './ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

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

export interface ActionSuccessorDispatchRecoveryStats {
  readonly scanned: number;
  readonly delivered: number;
  readonly pending: number;
}

export type ActionSuccessorDispatchDeliveryResult =
  | { readonly outcome: 'enqueued'; readonly deliveredMessageId: string }
  | { readonly outcome: 'unavailable' };

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
  readonly dispatch?: {
    readonly leaseStore: Pick<
      ActionSuccessorLeaseStore,
      'listPendingDispatches' | 'recordDispatchDeliveryAttempt' | 'markDispatchDelivered'
    >;
    readonly loadProposal: (proposalId: string) => Promise<DispatchProposal | null>;
    readonly loadOwnerAuthProvenance: (proposalId: string) => Promise<OwnerAuthProvenance | undefined>;
    readonly recordProposalDelivery: (proposalId: string, deliveredMessageId: string) => Promise<void>;
    readonly deliver: (
      proposal: DispatchProposal,
      fence: ActionSuccessorFence,
      ownerAuthProvenance: OwnerAuthProvenance,
    ) => Promise<ActionSuccessorDispatchDeliveryResult>;
  };
}

interface ReturnRecoveryResult {
  readonly outcome: 'ignored' | 'delivered' | 'pending';
  readonly overdue: boolean;
}

export type DispatchRecoveryResult =
  | { readonly outcome: 'delivered'; readonly deliveredMessageId: string }
  | { readonly outcome: 'ignored' | 'pending' };

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

  constructor(private readonly deps: ActionSuccessorRecoverySweepDeps) {
    this.now = deps.now ?? Date.now;
    this.scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
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
    const dispatch = this.deps.dispatch;
    if (!dispatch) return { scanned: 0, delivered: 0, pending: 0 };
    const leases = await dispatch.leaseStore.listPendingDispatches(this.scanLimit);
    let delivered = 0;
    let pending = 0;
    for (const lease of leases) {
      const result = await this.recoverDispatch(lease);
      if (result.outcome === 'delivered') delivered += 1;
      if (result.outcome === 'pending') pending += 1;
    }
    return { scanned: leases.length, delivered, pending };
  }

  async recoverDispatch(candidate: ActionSuccessorLease): Promise<DispatchRecoveryResult> {
    const dispatch = this.deps.dispatch;
    if (!dispatch) throw new Error('ActionSuccessor dispatch recovery is not configured');
    if (candidate.dispatchDeliveryState === 'delivered' && candidate.dispatchDeliveredMessageId) {
      return { outcome: 'delivered', deliveredMessageId: candidate.dispatchDeliveredMessageId };
    }
    const now = this.now();
    const attempt = await dispatch.leaseStore.recordDispatchDeliveryAttempt(candidate.leaseId, {
      expectedGeneration: candidate.generation,
      now,
    });
    if (attempt.outcome !== 'recorded') {
      if (attempt.lease.dispatchDeliveryState === 'delivered' && attempt.lease.dispatchDeliveredMessageId) {
        return { outcome: 'delivered', deliveredMessageId: attempt.lease.dispatchDeliveredMessageId };
      }
      return { outcome: 'ignored' };
    }
    const proposalId = proposalIdFromDispatch(attempt.lease.dispatchId);
    if (!proposalId) return { outcome: 'ignored' };
    const proposal = await dispatch.loadProposal(proposalId);
    if (
      proposal?.status !== 'approved' ||
      proposal.actionLeaseRef?.leaseId !== attempt.lease.leaseId ||
      proposal.actionLeaseRef.generation !== attempt.lease.generation ||
      proposal.actionLeaseRef.dispatchId !== attempt.lease.dispatchId ||
      proposal.actionLeaseRef.terminalPredicateDigest !== attempt.lease.terminalPredicate?.digest
    ) {
      return { outcome: 'ignored' };
    }

    if (proposal.deliveredMessageId) {
      return this.markDispatchDelivered(attempt.lease, proposal.deliveredMessageId, now);
    }

    let result: ActionSuccessorDispatchDeliveryResult = { outcome: 'unavailable' };
    try {
      const ownerAuthProvenance = normalizeOwnerAuthProvenance(await dispatch.loadOwnerAuthProvenance(proposalId));
      result = await dispatch.deliver(
        proposal,
        buildActionSuccessorFence(attempt.lease, attempt.lease.dispatchId),
        ownerAuthProvenance,
      );
    } catch (err) {
      log.warn(
        { err, leaseId: attempt.lease.leaseId, generation: attempt.lease.generation, proposalId },
        'F246 ActionSuccessor approved carrier delivery failed',
      );
    }
    if (result.outcome !== 'enqueued') return { outcome: 'pending' };

    await dispatch.recordProposalDelivery(proposalId, result.deliveredMessageId);
    return this.markDispatchDelivered(attempt.lease, result.deliveredMessageId, now);
  }

  private async markDispatchDelivered(
    lease: ActionSuccessorLease,
    deliveredMessageId: string,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    const dispatch = this.deps.dispatch;
    if (!dispatch) throw new Error('ActionSuccessor dispatch recovery is not configured');
    const marked = await dispatch.leaseStore.markDispatchDelivered(lease.leaseId, {
      expectedGeneration: lease.generation,
      deliveredMessageId,
      evidenceRef: `message:${deliveredMessageId}`,
      now,
    });
    if (marked.outcome === 'delivered' || marked.lease.dispatchDeliveryState === 'delivered') {
      return { outcome: 'delivered', deliveredMessageId };
    }
    return { outcome: 'pending' };
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

function proposalIdFromDispatch(dispatchId: string): string | null {
  return dispatchId.startsWith('approval:') && dispatchId.length > 'approval:'.length
    ? dispatchId.slice('approval:'.length)
    : null;
}
