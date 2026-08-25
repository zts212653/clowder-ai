import type { ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorCompletionResult } from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  type CarrierlessLocalReviewFence,
  type CarrierlessLocalReviewInput,
  type CarrierlessLocalReviewPreflightResult,
  hasStructuredPredecessor,
  resolveCarrierlessLocalReview,
} from './CarrierlessLocalReviewResolver.js';
import { type LocalReviewEvidenceProvider } from './LocalReviewEvidenceProvider.js';

export type {
  CarrierlessLocalReviewFence,
  CarrierlessLocalReviewInput,
  CarrierlessLocalReviewPreflightResult,
} from './CarrierlessLocalReviewResolver.js';

export type LocalReviewVerdictRecordResult =
  | { outcome: 'committed'; leaseId: string; generation: number; evidenceRef: string }
  | { outcome: 'mismatch' | 'insufficient' | 'stale'; reason: string };

export interface LocalReviewVerdictServiceDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'getByIdentity' | 'recoverLocalReviewVerdict'>;
  evidenceProvider: LocalReviewEvidenceProvider;
  truthResolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>;
  completeActionLease(input: {
    leaseId: string;
    generation: number;
    catId: string;
    evidenceRefs: string[];
    now: number;
  }): Promise<ActionSuccessorCompletionResult>;
}

interface LocalReviewRecoveryInput {
  leaseId: string;
  generation: number;
  messageId: string;
  now: number;
  principal: { catId: string; threadId: string; tenantScope: string };
}

type ReviewDeliveryTerminalPredicate = CanonicalActionTerminalPredicate & {
  readonly kind: 'review_delivered';
  readonly headSha: string;
};

type LocalReviewRecoveryPreflight =
  | {
      ok: true;
      reviewerCatId: string;
      predecessorCatId: string;
      predecessorThreadId: string;
      terminalPredicate: ReviewDeliveryTerminalPredicate;
    }
  | { ok: false; result: Exclude<LocalReviewVerdictRecordResult, { outcome: 'committed' }> };

function isUntouchedRecoveryGeneration(lease: ActionSuccessorLease): boolean {
  return Object.keys(lease.holderOutcomes).length === 0 && Object.keys(lease.completionCandidates).length === 0;
}

function hasRecoverableReviewStatus(lease: ActionSuccessorLease): boolean {
  return lease.status === 'active' || lease.status === 'completed';
}

function preflightLocalReviewRecovery(
  lease: ActionSuccessorLease,
  input: LocalReviewRecoveryInput,
): LocalReviewRecoveryPreflight {
  if (lease.generation !== input.generation) {
    return { ok: false, result: { outcome: 'stale', reason: 'stale_generation' } };
  }
  if (!hasRecoverableReviewStatus(lease)) {
    return { ok: false, result: { outcome: 'stale', reason: 'lease_not_active' } };
  }
  if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
    return { ok: false, result: { outcome: 'mismatch', reason: 'action lease is not local review custody' } };
  }
  const reviewerCatId = lease.holderCatIds[0];
  if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !reviewerCatId) {
    return { ok: false, result: { outcome: 'mismatch', reason: 'local review recovery requires one review holder' } };
  }
  if (!hasStructuredPredecessor(lease)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery requires structured predecessor custody' },
    };
  }
  if (lease.predecessorCatId !== input.principal.catId) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery caller is not the lease predecessor' },
    };
  }
  if (lease.tenantScope !== input.principal.tenantScope) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery caller is outside the predecessor tenant' },
    };
  }
  if (lease.status === 'active' && !isUntouchedRecoveryGeneration(lease)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery requires an untouched active generation' },
    };
  }
  if (lease.returnTransitions.length > 0) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery does not accept returned generations' },
    };
  }
  if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
    return { ok: false, result: { outcome: 'insufficient', reason: 'review delivery predicate unavailable' } };
  }
  return {
    ok: true,
    reviewerCatId,
    predecessorCatId: lease.predecessorCatId,
    predecessorThreadId: lease.predecessorThreadId,
    terminalPredicate: {
      ...lease.terminalPredicate,
      kind: 'review_delivered',
      headSha: lease.terminalPredicate.headSha,
    },
  };
}

/**
 * Machine-checkable completion producer for local cat reviews. Unlike the
 * external F168 producer, this path never accepts a GitHub URL or writes a
 * community verdict. It only settles custody after re-reading an already
 * persisted typed verdict from the structured predecessor route. Subject,
 * exact HEAD, holder, route, tenant, lease, and generation come from server truth.
 */
export class LocalReviewVerdictService {
  constructor(private readonly deps: LocalReviewVerdictServiceDeps) {}

  async record(input: {
    leaseId: string;
    generation: number;
    messageId: string;
    now: number;
    reviewedHeadSha?: string;
    principal: { catId: string; threadId: string; tenantScope: string };
  }): Promise<LocalReviewVerdictRecordResult> {
    const lease = await this.deps.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };
    if (lease.generation !== input.generation) return { outcome: 'stale', reason: 'stale_generation' };
    if (!lease.holderCatIds.includes(input.principal.catId)) {
      return { outcome: 'mismatch', reason: 'local review caller is not a lease holder' };
    }
    if (lease.holderThreadId !== input.principal.threadId || lease.tenantScope !== input.principal.tenantScope) {
      return { outcome: 'mismatch', reason: 'local review callback principal does not match lease' };
    }
    if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
      return { outcome: 'mismatch', reason: 'action lease is not local review custody' };
    }
    if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
      return { outcome: 'insufficient', reason: 'review delivery predicate unavailable' };
    }
    if (input.reviewedHeadSha && input.reviewedHeadSha !== lease.terminalPredicate.headSha) {
      return { outcome: 'stale', reason: 'reviewed_head_mismatch' };
    }
    const evidence = await this.deps.evidenceProvider.resolve({
      messageId: input.messageId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      reviewerCatId: input.principal.catId,
      holderThreadId: lease.holderThreadId,
      predecessorCatId: lease.predecessorCatId,
      predecessorThreadId: lease.predecessorThreadId,
      tenantScope: lease.tenantScope,
      ...(input.reviewedHeadSha ? { reviewedHeadSha: input.reviewedHeadSha } : {}),
    });
    if (evidence.status !== 'verified') return { outcome: evidence.status, reason: evidence.reason };
    const { evidenceRef } = evidence;

    const completion = await this.deps.completeActionLease({
      leaseId: input.leaseId,
      generation: input.generation,
      catId: input.principal.catId,
      evidenceRefs: [evidenceRef],
      now: input.now,
    });
    return completion.outcome === 'committed' ? { ...completion, evidenceRef } : completion;
  }

  async preflightCarrierless(input: CarrierlessLocalReviewInput): Promise<CarrierlessLocalReviewPreflightResult> {
    const resolved = await resolveCarrierlessLocalReview(this.deps.leaseStore, input);
    if (resolved.outcome !== 'resolved') return resolved;
    const { lease: _lease, ...preflight } = resolved;
    return preflight;
  }

  async recordCarrierless(
    input: CarrierlessLocalReviewInput & CarrierlessLocalReviewFence & { messageId: string; now: number },
  ): Promise<LocalReviewVerdictRecordResult> {
    const resolved = await resolveCarrierlessLocalReview(this.deps.leaseStore, input, {
      leaseId: input.leaseId,
      generation: input.generation,
    });
    if (resolved.outcome !== 'resolved') return resolved;
    const { lease } = resolved;
    const evidence = await this.deps.evidenceProvider.resolve({
      messageId: input.messageId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      reviewerCatId: input.principal.catId,
      holderThreadId: lease.holderThreadId,
      predecessorCatId: lease.predecessorCatId,
      predecessorThreadId: lease.predecessorThreadId,
      tenantScope: lease.tenantScope,
      reviewedHeadSha: input.reviewedHeadSha,
    });
    if (evidence.status !== 'verified') return { outcome: evidence.status, reason: evidence.reason };
    const { evidenceRef } = evidence;
    if (lease.status === 'completed') {
      const settled = lease.holderOutcomes[input.principal.catId];
      return settled?.outcome === 'succeeded' && settled.evidenceRef === evidenceRef
        ? { outcome: 'committed', leaseId: lease.leaseId, generation: lease.generation, evidenceRef }
        : { outcome: 'stale', reason: 'lease_not_active' };
    }
    const completion = await this.deps.completeActionLease({
      leaseId: lease.leaseId,
      generation: lease.generation,
      catId: input.principal.catId,
      evidenceRefs: [evidenceRef],
      now: input.now,
    });
    return completion.outcome === 'committed' ? { ...completion, evidenceRef } : completion;
  }

  /**
   * Historical settlement for one carrierless review verdict after the PR HEAD
   * has advanced. The authenticated predecessor cat and tenant are the caller
   * principal; the persisted predecessor thread remains server-resolved message
   * routing evidence rather than an ephemeral invocation requirement. Normal
   * holder completion and active replacement keep their existing auth paths.
   */
  async recover(input: LocalReviewRecoveryInput): Promise<LocalReviewVerdictRecordResult> {
    const lease = await this.deps.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };
    const preflight = preflightLocalReviewRecovery(lease, input);
    if (!preflight.ok) return preflight.result;

    const { reviewerCatId, predecessorCatId, predecessorThreadId, terminalPredicate } = preflight;

    const evidence = await this.deps.evidenceProvider.resolveRecovery({
      messageId: input.messageId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      reviewerCatId,
      holderThreadId: lease.holderThreadId,
      predecessorCatId: lease.predecessorCatId,
      predecessorThreadId: lease.predecessorThreadId,
      tenantScope: lease.tenantScope,
    });
    if (evidence.status !== 'verified') return { outcome: evidence.status, reason: evidence.reason };
    const { evidenceRef } = evidence;

    if (lease.status === 'completed') {
      const settled = lease.holderOutcomes[reviewerCatId];
      return settled?.outcome === 'succeeded' && settled.evidenceRef === evidenceRef
        ? { outcome: 'committed', leaseId: input.leaseId, generation: input.generation, evidenceRef }
        : { outcome: 'stale', reason: 'lease_not_active' };
    }

    const freshness = await this.deps.truthResolver.resolveFreshness(terminalPredicate);
    if (freshness.status === 'verified') {
      return { outcome: 'mismatch', reason: 'local review lease HEAD is still current' };
    }
    if (freshness.status === 'insufficient') return { outcome: 'insufficient', reason: freshness.reason };

    const completion = await this.deps.leaseStore.recoverLocalReviewVerdict(input.leaseId, {
      expectedGeneration: input.generation,
      reviewerCatId,
      predecessorCatId,
      predecessorThreadId,
      tenantScope: input.principal.tenantScope,
      headSha: terminalPredicate.headSha,
      evidenceRef,
      now: input.now,
    });
    return completion.outcome === 'recovered' || completion.outcome === 'replayed'
      ? { outcome: 'committed', leaseId: input.leaseId, generation: input.generation, evidenceRef }
      : { outcome: 'stale', reason: completion.outcome };
  }
}
