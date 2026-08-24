import type { DispatchProposal } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import {
  type ActionSuccessorFence,
  actionSuccessorStandingMismatchDimensions,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorDispatchFailureReason, ActionSuccessorLease } from './action-successor-state-machine.js';

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
  readonly leaseStore: Pick<
    ActionSuccessorLeaseStore,
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
  readonly now?: () => number;
  readonly scanLimit?: number;
}

export type DispatchRecoveryResult =
  | { readonly outcome: 'delivered'; readonly deliveredMessageId: string }
  | { readonly outcome: 'failed'; readonly reason: ActionSuccessorDispatchFailureReason }
  | { readonly outcome: 'ignored' | 'pending' };

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
  private readonly now: () => number;
  private readonly scanLimit: number;

  constructor(private readonly deps: ActionSuccessorDispatchRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
  }

  async runOnce(): Promise<ActionSuccessorDispatchRecoveryStats> {
    const leases = await this.deps.leaseStore.listPendingDispatches(this.scanLimit);
    let delivered = 0;
    let pending = 0;
    let failed = 0;
    for (const lease of leases) {
      const result = await this.recover(lease);
      if (result.outcome === 'delivered') delivered += 1;
      if (result.outcome === 'pending') pending += 1;
      if (result.outcome === 'failed') failed += 1;
    }
    return { scanned: leases.length, delivered, pending, failed };
  }

  async recover(candidate: ActionSuccessorLease): Promise<DispatchRecoveryResult> {
    if (candidate.dispatchDeliveryState === 'delivered' && candidate.dispatchDeliveredMessageId) {
      return { outcome: 'delivered', deliveredMessageId: candidate.dispatchDeliveredMessageId };
    }
    const predicate = candidate.terminalPredicate;
    if (!predicate) return { outcome: 'pending' };

    const now = this.now();
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
      return { outcome: 'pending' };
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
    const ownerAuthProvenance = await this.loadOwnerAuthProvenance(attempt.lease, proposalState.proposalId);
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
    const ownerAuthProvenance = await this.loadOwnerAuthProvenance(lease, proposalState.proposalId);
    if (!ownerAuthProvenance) return { outcome: 'pending' };
    return this.deliverApproved(lease, proposalState.proposalId, proposalState.proposal, ownerAuthProvenance, now);
  }

  private async loadOwnerAuthProvenance(
    lease: ActionSuccessorLease,
    proposalId: string,
  ): Promise<OwnerAuthProvenance | null> {
    try {
      return normalizeOwnerAuthProvenance(await this.deps.loadOwnerAuthProvenance(proposalId));
    } catch (err) {
      log.warn(
        { err, leaseId: lease.leaseId, generation: lease.generation, proposalId },
        'F246 ActionSuccessor owner auth provenance recovery failed closed',
      );
      return null;
    }
  }

  private async deliverApproved(
    lease: ActionSuccessorLease,
    proposalId: string,
    proposal: DispatchProposal,
    ownerAuthProvenance: OwnerAuthProvenance,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    let result: ActionSuccessorDispatchDeliveryResult = { outcome: 'unavailable' };
    try {
      result = await this.deps.deliver(
        proposal,
        buildActionSuccessorFence(lease, lease.dispatchId),
        ownerAuthProvenance,
      );
    } catch (err) {
      log.warn(
        { err, leaseId: lease.leaseId, generation: lease.generation, proposalId },
        'F246 ActionSuccessor approved carrier delivery failed',
      );
    }
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
