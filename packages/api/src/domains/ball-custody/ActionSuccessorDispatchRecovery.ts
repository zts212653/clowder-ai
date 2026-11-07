import type { DispatchProposal } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { recoveryGuarded } from '../../infrastructure/recovery/recovery-deadline.js';
import { runDueBatch } from '../../infrastructure/recovery/run-due-batch.js';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import {
  type ActionSuccessorFence,
  actionSuccessorStandingMismatchDimensions,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { recordActionRecoveryBatchFailure, runActionDueRecovery } from './action-successor-due-recovery.js';
import type { ActionRecoveryNotification } from './action-successor-recovery-state.js';
import type { ActionSuccessorDispatchFailureReason, ActionSuccessorLease } from './action-successor-state-machine.js';
import { isRetiredTaskAction } from './retired-task-action.js';

export type { ApprovedActionCarrierClassification } from './approved-action-carrier-classification.js';
export { classifyApprovedActionCarrier } from './approved-action-carrier-classification.js';

const log = createModuleLogger('ball-custody/action-successor-dispatch-recovery');
const DEFAULT_SCAN_LIMIT = 100;

export interface ActionSuccessorDispatchRecoveryStats {
  readonly scanned: number;
  readonly delivered: number;
  readonly pending: number;
  readonly failed: number;
}

export type ActionSuccessorDispatchDeliveryResult =
  | { readonly outcome: 'enqueued'; readonly deliveredMessageId: string }
  | { readonly outcome: 'unavailable' }
  | {
      readonly outcome: 'terminal_failure';
      readonly reason: ActionSuccessorDispatchFailureReason;
      readonly evidenceRef: string;
    };

export interface ActionSuccessorDispatchRecoveryDeps {
  readonly tasks?: Pick<ITaskStore, 'get'>;
  readonly leaseStore: Pick<
    ActionSuccessorLeaseStore,
    | 'recovery'
    | 'listPendingDispatches'
    | 'recordDispatchDeliveryAttempt'
    | 'reserveDispatchDelivery'
    | 'retirePendingDispatchForFreshnessMismatch'
    | 'markDispatchDelivered'
    | 'markDispatchFailed'
  >;
  readonly truthResolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>;
  readonly loadProposal: (proposalId: string) => Promise<DispatchProposal | null>;
  readonly loadOwnerAuthProvenance: (proposalId: string) => Promise<OwnerAuthProvenance | undefined>;
  readonly recordProposalDelivery: (proposalId: string, deliveredMessageId: string) => Promise<void>;
  readonly deliver: (
    proposal: DispatchProposal,
    fence: ActionSuccessorFence,
    ownerAuthProvenance: OwnerAuthProvenance,
  ) => Promise<ActionSuccessorDispatchDeliveryResult>;
  readonly notifyRecovery?: ActionRecoveryNotification;
  readonly now?: () => number;
  readonly scanLimit?: number;
}

export type DispatchRecoveryResult =
  | { readonly outcome: 'delivered'; readonly deliveredMessageId: string }
  | { readonly outcome: 'failed'; readonly reason: ActionSuccessorDispatchFailureReason }
  | { readonly outcome: 'ignored' | 'pending'; readonly recoveryFailure?: string };

type ApprovedDispatchProposalClassification =
  | { readonly outcome: 'approved'; readonly proposalId: string; readonly proposal: DispatchProposal }
  | {
      readonly outcome: 'failure';
      readonly reason: ActionSuccessorDispatchFailureReason;
      readonly evidenceRef: string;
    };

function classifyApprovedDispatchProposal(
  proposalId: string | null,
  proposal: DispatchProposal | null,
  lease: ActionSuccessorLease,
): ApprovedDispatchProposalClassification {
  if (!proposalId) {
    return {
      outcome: 'failure',
      reason: 'proposal_fence_mismatch',
      evidenceRef: `dispatch:${lease.dispatchId}`,
    };
  }
  if (!proposal) return { outcome: 'failure', reason: 'proposal_missing', evidenceRef: `proposal:${proposalId}` };
  if (proposal.status !== 'approved') {
    return { outcome: 'failure', reason: 'proposal_not_approved', evidenceRef: `proposal:${proposalId}` };
  }
  const fenceMatches =
    proposal.actionLeaseRef?.leaseId === lease.leaseId &&
    proposal.actionLeaseRef.generation === lease.generation &&
    proposal.actionLeaseRef.dispatchId === lease.dispatchId &&
    proposal.actionLeaseRef.terminalPredicateDigest === lease.terminalPredicate?.digest;
  return fenceMatches
    ? { outcome: 'approved', proposalId, proposal }
    : { outcome: 'failure', reason: 'proposal_fence_mismatch', evidenceRef: `proposal:${proposalId}` };
}

export class ActionSuccessorDispatchRecovery {
  private inFlight: Promise<ActionSuccessorDispatchRecoveryStats> | undefined;
  private readonly now: () => number;
  private readonly scanLimit: number;

  constructor(private readonly deps: ActionSuccessorDispatchRecoveryDeps) {
    this.deps = recoveryGuarded(deps);
    this.now = deps.now ?? Date.now;
    this.scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
  }

  runOnce(): Promise<ActionSuccessorDispatchRecoveryStats> {
    if (this.inFlight) return this.inFlight;
    const cycle = this.runCycle().finally(() => {
      if (this.inFlight === cycle) this.inFlight = undefined;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async runCycle(): Promise<ActionSuccessorDispatchRecoveryStats> {
    let delivered = 0;
    let pending = 0;
    let failed = 0;
    const batch = await runDueBatch({
      limit: this.scanLimit,
      budgetMs: 5000,
      selectDue: async (limit) => await this.deps.leaseStore.listPendingDispatches(limit, this.now()),
      process: async (lease) => {
        const outcome = await runActionDueRecovery({
          port: this.deps.leaseStore.recovery,
          lease,
          lane: 'dispatch',
          now: this.now(),
          notify: this.deps.notifyRecovery,
          recover: async (current) => {
            if (!current.terminalPredicate) return { kind: 'permanent_error', reason: 'dispatch_predicate_missing' };
            const result = await this.recover(current);
            if (result.outcome === 'delivered') delivered += 1;
            if (result.outcome === 'pending') pending += 1;
            if (result.outcome === 'failed') failed += 1;
            if ('recoveryFailure' in result && result.recoveryFailure)
              return { kind: 'retryable_error', reason: result.recoveryFailure };
            return { kind: result.outcome === 'pending' ? 'waiting' : 'settled' };
          },
        });
        if (outcome.kind === 'retryable_error') failed += 1;
      },
      onItemError: (lease, error) =>
        recordActionRecoveryBatchFailure(this.deps.leaseStore.recovery, lease, 'dispatch', this.now(), error),
    });
    return { scanned: batch.selected, delivered, pending, failed: failed + batch.failed };
  }

  async recover(candidate: ActionSuccessorLease): Promise<DispatchRecoveryResult> {
    try {
      return await this.recoverCandidate(candidate);
    } catch {
      return { outcome: 'pending', recoveryFailure: 'dispatch_recovery_read_failed' };
    }
  }

  private async recoverCandidate(candidate: ActionSuccessorLease): Promise<DispatchRecoveryResult> {
    if (await isRetiredTaskAction(this.deps.tasks, candidate)) return { outcome: 'ignored' };
    if (candidate.dispatchDeliveryState === 'delivered' && candidate.dispatchDeliveredMessageId) {
      return { outcome: 'delivered', deliveredMessageId: candidate.dispatchDeliveredMessageId };
    }
    const predicate = candidate.terminalPredicate;
    if (!predicate) return { outcome: 'pending' };

    const now = this.now();
    return this.recoverAuthorized(candidate, now);
  }

  private async recoverAuthorized(candidate: ActionSuccessorLease, now: number): Promise<DispatchRecoveryResult> {
    const predicate = candidate.terminalPredicate;
    if (!predicate) return { outcome: 'pending' };
    if (candidate.dispatchDeliveryReservation) {
      return this.recoverReserved(candidate, now);
    }
    let freshness: ActionFreshnessResolution;
    try {
      freshness = await this.deps.truthResolver.resolveFreshness(predicate);
    } catch (err) {
      log.warn(
        { err, leaseId: candidate.leaseId, generation: candidate.generation },
        'ActionSuccessor dispatch recovery freshness resolution failed closed',
      );
      return { outcome: 'pending', recoveryFailure: 'dispatch_freshness_read_failed' };
    }
    if (freshness.status === 'insufficient') return { outcome: 'pending' };
    if (freshness.status === 'mismatch') {
      return this.retireFreshnessMismatch(candidate, freshness.evidenceRef, now);
    }
    const standingMismatch = actionSuccessorStandingMismatchDimensions(
      {
        holderCatIds: candidate.holderCatIds,
        targetThreadId: candidate.holderThreadId,
        tenantScope: candidate.tenantScope,
      },
      freshness,
    );
    if (freshness.freshnessKey !== predicate.freshnessKey || standingMismatch.length > 0) {
      return this.retireFreshnessMismatch(candidate, freshness.evidenceRef, now);
    }

    const attempt = await this.deps.leaseStore.recordDispatchDeliveryAttempt(candidate.leaseId, {
      expectedGeneration: candidate.generation,
      expectedRevision: candidate.revision,
      expectedPredicateDigest: predicate.digest,
      freshnessEvidenceRef: freshness.evidenceRef,
      now,
    });
    if (attempt.outcome !== 'recorded') return dispatchStateResult(attempt.lease);

    const proposalId = proposalIdFromDispatch(attempt.lease.dispatchId);
    const proposalState = classifyApprovedDispatchProposal(
      proposalId,
      proposalId ? await this.deps.loadProposal(proposalId) : null,
      attempt.lease,
    );
    if (proposalState.outcome === 'failure') {
      return this.markFailed(attempt.lease, proposalState.reason, proposalState.evidenceRef, now);
    }
    const ownerAuthProvenance = await this.loadOwnerAuthProvenance(proposalState.proposalId);
    if (!ownerAuthProvenance) return { outcome: 'pending' };
    const reservation = await this.deps.leaseStore.reserveDispatchDelivery(attempt.lease.leaseId, {
      expectedGeneration: attempt.lease.generation,
      expectedRevision: attempt.lease.revision,
      expectedPredicateDigest: predicate.digest,
      freshnessEvidenceRef: freshness.evidenceRef,
      now,
    });
    if (reservation.outcome !== 'reserved') return dispatchStateResult(reservation.lease);
    return this.deliverApproved(
      reservation.lease,
      proposalState.proposalId,
      proposalState.proposal,
      ownerAuthProvenance,
      now,
    );
  }

  private async recoverReserved(lease: ActionSuccessorLease, now: number): Promise<DispatchRecoveryResult> {
    const proposalId = proposalIdFromDispatch(lease.dispatchId);
    const proposalState = classifyApprovedDispatchProposal(
      proposalId,
      proposalId ? await this.deps.loadProposal(proposalId) : null,
      lease,
    );
    if (proposalState.outcome === 'failure') {
      return this.markFailed(lease, proposalState.reason, proposalState.evidenceRef, now);
    }
    const ownerAuthProvenance = await this.loadOwnerAuthProvenance(proposalState.proposalId);
    if (!ownerAuthProvenance) return { outcome: 'pending' };
    return this.deliverApproved(lease, proposalState.proposalId, proposalState.proposal, ownerAuthProvenance, now);
  }

  private async loadOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | null> {
    return normalizeOwnerAuthProvenance(await this.deps.loadOwnerAuthProvenance(proposalId));
  }

  private async deliverApproved(
    lease: ActionSuccessorLease,
    proposalId: string,
    proposal: DispatchProposal,
    ownerAuthProvenance: OwnerAuthProvenance,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    let result: ActionSuccessorDispatchDeliveryResult = { outcome: 'unavailable' };
    let deliveryErrored = false;
    try {
      result = await this.deps.deliver(
        proposal,
        buildActionSuccessorFence(lease, lease.dispatchId),
        ownerAuthProvenance,
      );
    } catch (err) {
      deliveryErrored = true;
      log.warn(
        { err, leaseId: lease.leaseId, generation: lease.generation, proposalId },
        'F246 ActionSuccessor approved carrier delivery failed',
      );
    }
    if (result.outcome === 'unavailable' && deliveryErrored)
      return { outcome: 'pending', recoveryFailure: 'dispatch_delivery_failed' };
    if (result.outcome === 'terminal_failure') {
      return this.markFailed(lease, result.reason, result.evidenceRef, now);
    }
    if (result.outcome !== 'enqueued') return { outcome: 'pending' };
    if (proposal.deliveredMessageId && proposal.deliveredMessageId !== result.deliveredMessageId) {
      return this.markFailed(lease, 'carrier_receipt_conflict', `message:${proposal.deliveredMessageId}`, now);
    }
    if (!proposal.deliveredMessageId) {
      await this.deps.recordProposalDelivery(proposalId, result.deliveredMessageId);
    }
    return this.markDelivered(lease, result.deliveredMessageId, now);
  }

  private async retireFreshnessMismatch(
    lease: ActionSuccessorLease,
    evidenceRef: string,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    const predicate = lease.terminalPredicate;
    if (!predicate) return { outcome: 'pending' };
    const result = await this.deps.leaseStore.retirePendingDispatchForFreshnessMismatch(lease.leaseId, {
      expectedGeneration: lease.generation,
      expectedRevision: lease.revision,
      expectedPredicateDigest: predicate.digest,
      evidenceRef,
      now,
    });
    return dispatchStateResult(result.lease);
  }

  private async markFailed(
    lease: ActionSuccessorLease,
    reason: ActionSuccessorDispatchFailureReason,
    evidenceRef: string,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    const predicate = lease.terminalPredicate;
    if (!predicate) return { outcome: 'pending' };
    const failed = await this.deps.leaseStore.markDispatchFailed(lease.leaseId, {
      expectedGeneration: lease.generation,
      expectedRevision: lease.revision,
      expectedPredicateDigest: predicate.digest,
      reason,
      evidenceRef,
      now,
    });
    if (failed.outcome === 'failed') return { outcome: 'failed', reason };
    if (failed.lease.dispatchDeliveryState !== 'failed') return { outcome: 'ignored' };
    if (!failed.lease.dispatchFailureReason) {
      throw new Error(`failed ActionSuccessor dispatch is missing a failure reason: ${lease.leaseId}`);
    }
    return { outcome: 'failed', reason: failed.lease.dispatchFailureReason };
  }

  private async markDelivered(
    lease: ActionSuccessorLease,
    deliveredMessageId: string,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    const predicate = lease.terminalPredicate;
    const reservation = lease.dispatchDeliveryReservation;
    if (!predicate || !reservation) return { outcome: 'pending' };
    const marked = await this.deps.leaseStore.markDispatchDelivered(lease.leaseId, {
      expectedGeneration: lease.generation,
      expectedRevision: lease.revision,
      expectedPredicateDigest: predicate.digest,
      freshnessEvidenceRef: reservation.freshnessEvidenceRef,
      deliveredMessageId,
      evidenceRef: `message:${deliveredMessageId}`,
      now,
    });
    return marked.outcome === 'delivered' || marked.lease.dispatchDeliveryState === 'delivered'
      ? { outcome: 'delivered', deliveredMessageId }
      : { outcome: 'pending' };
  }
}

function dispatchStateResult(lease: ActionSuccessorLease): DispatchRecoveryResult {
  if (lease.dispatchDeliveryState === 'delivered' && lease.dispatchDeliveredMessageId) {
    return { outcome: 'delivered', deliveredMessageId: lease.dispatchDeliveredMessageId };
  }
  if (lease.dispatchDeliveryState === 'failed' && lease.dispatchFailureReason) {
    return { outcome: 'failed', reason: lease.dispatchFailureReason };
  }
  return { outcome: 'ignored' };
}

function proposalIdFromDispatch(dispatchId: string): string | null {
  return dispatchId.startsWith('approval:') && dispatchId.length > 'approval:'.length
    ? dispatchId.slice('approval:'.length)
    : null;
}
