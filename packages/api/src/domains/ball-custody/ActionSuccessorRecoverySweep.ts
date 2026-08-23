import type { DispatchProposal } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { returnDeliveryOverdueTotal } from '../../infrastructure/telemetry/instruments.js';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { type ActionSuccessorFence, buildActionSuccessorFence } from './ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorDispatchFailureReason, ActionSuccessorLease } from './action-successor-state-machine.js';

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
      'listPendingDispatches' | 'recordDispatchDeliveryAttempt' | 'markDispatchDelivered' | 'markDispatchFailed'
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
  | { readonly outcome: 'failed'; readonly reason: ActionSuccessorDispatchFailureReason }
  | { readonly outcome: 'ignored' | 'pending' };

export type ApprovedActionCarrierClassification =
  | { readonly outcome: 'repairable' }
  | { readonly outcome: 'admitted' }
  | { readonly outcome: 'conflict'; readonly reason: ActionSuccessorDispatchFailureReason };

type ApprovedDispatchProposalClassification =
  | { readonly outcome: 'approved'; readonly proposalId: string; readonly proposal: DispatchProposal }
  | {
      readonly outcome: 'failure';
      readonly reason: ActionSuccessorDispatchFailureReason;
      readonly evidenceRef: string;
    };

function sameOrderedStrings(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function isRepairableQueueAdmission(status: StoredMessage['deliveryStatus']): boolean {
  return status === undefined ? true : status === 'queued';
}

function hasQueueAdmission(status: StoredMessage['deliveryStatus']): boolean {
  return status === 'queued' ? true : status === 'delivered';
}

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
  if (!proposal) {
    return { outcome: 'failure', reason: 'proposal_missing', evidenceRef: `proposal:${proposalId}` };
  }
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

/**
 * Classify only durable source/custody truth. The lease/proposal fence is
 * checked separately by the recovery sweep before this carrier is consulted.
 */
export function classifyApprovedActionCarrier(
  proposal: DispatchProposal,
  message: StoredMessage,
): ApprovedActionCarrierClassification {
  const targetCats = proposal.targetCats;
  const sourceMatches =
    message.threadId === proposal.targetThreadId &&
    message.userId === proposal.ownerUserId &&
    message.catId === proposal.senderCatId &&
    message.content === proposal.content &&
    message.origin === 'callback' &&
    message.replyTo === proposal.replyTo &&
    message.extra?.isExplicitPost === true &&
    message.extra.crossPost?.sourceThreadId === proposal.sourceThreadId &&
    message.extra.crossPost.effectClass === 'assign_work' &&
    sameOrderedStrings(message.mentions, targetCats) &&
    sameOrderedStrings(message.extra.targetCats, targetCats);
  if (!sourceMatches) return { outcome: 'conflict', reason: 'carrier_source_conflict' };

  const custody = message.queueCustody;
  if (!custody) {
    return isRepairableQueueAdmission(message.deliveryStatus)
      ? { outcome: 'repairable' }
      : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
  }
  const carrierByTargetCatId = custody.carrierByTargetCatId;
  if (!carrierByTargetCatId) return { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
  const carrierTargetCats = Object.keys(carrierByTargetCatId);
  const custodyMatches =
    hasQueueAdmission(message.deliveryStatus) &&
    custody.entryId === `cross-thread:${message.id}` &&
    custody.intent === 'execute' &&
    custody.ownerUserId === proposal.ownerUserId &&
    custody.receiptScope === 'cross_thread_delivery' &&
    sameOrderedStrings(custody.allTargetCats, targetCats) &&
    sameOrderedStrings(carrierTargetCats, targetCats) &&
    targetCats.every((catId) => {
      const binding = carrierByTargetCatId[catId];
      return (
        binding?.source === 'agent' &&
        binding.sourceCategory === 'a2a' &&
        binding.callerCatId === proposal.senderCatId &&
        binding.a2aTriggerMessageId === message.id &&
        binding.autoExecute === true &&
        binding.entryId.length > 0
      );
    });
  return custodyMatches ? { outcome: 'admitted' } : { outcome: 'conflict', reason: 'carrier_receipt_conflict' };
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
    if (!dispatch) return { scanned: 0, delivered: 0, pending: 0, failed: 0 };
    const leases = await dispatch.leaseStore.listPendingDispatches(this.scanLimit);
    let delivered = 0;
    let pending = 0;
    let failed = 0;
    for (const lease of leases) {
      const result = await this.recoverDispatch(lease);
      if (result.outcome === 'delivered') delivered += 1;
      if (result.outcome === 'pending') pending += 1;
      if (result.outcome === 'failed') failed += 1;
    }
    return { scanned: leases.length, delivered, pending, failed };
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
    const proposalState = classifyApprovedDispatchProposal(
      proposalId,
      proposalId ? await dispatch.loadProposal(proposalId) : null,
      attempt.lease,
    );
    if (proposalState.outcome === 'failure') {
      return this.markDispatchFailed(attempt.lease, proposalState.reason, proposalState.evidenceRef, now);
    }
    const approvedProposalId = proposalState.proposalId;
    const proposal = proposalState.proposal;

    let result: ActionSuccessorDispatchDeliveryResult = { outcome: 'unavailable' };
    try {
      const ownerAuthProvenance = normalizeOwnerAuthProvenance(
        await dispatch.loadOwnerAuthProvenance(approvedProposalId),
      );
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
    if (result.outcome === 'terminal_failure') {
      return this.markDispatchFailed(attempt.lease, result.reason, result.evidenceRef, now);
    }
    if (result.outcome !== 'enqueued') return { outcome: 'pending' };
    if (proposal.deliveredMessageId && proposal.deliveredMessageId !== result.deliveredMessageId) {
      return this.markDispatchFailed(
        attempt.lease,
        'carrier_receipt_conflict',
        `message:${proposal.deliveredMessageId}`,
        now,
      );
    }

    if (!proposal.deliveredMessageId) {
      await dispatch.recordProposalDelivery(approvedProposalId, result.deliveredMessageId);
    }
    return this.markDispatchDelivered(attempt.lease, result.deliveredMessageId, now);
  }

  private async markDispatchFailed(
    lease: ActionSuccessorLease,
    reason: ActionSuccessorDispatchFailureReason,
    evidenceRef: string,
    now: number,
  ): Promise<DispatchRecoveryResult> {
    const dispatch = this.deps.dispatch;
    if (!dispatch) throw new Error('ActionSuccessor dispatch recovery is not configured');
    const failed = await dispatch.leaseStore.markDispatchFailed(lease.leaseId, {
      expectedGeneration: lease.generation,
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
