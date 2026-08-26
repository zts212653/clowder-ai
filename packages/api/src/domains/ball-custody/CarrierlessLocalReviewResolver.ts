import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { type ActionSuccessorLease, canonicalizeActionSubjectRef } from './action-successor-state-machine.js';

export interface CarrierlessLocalReviewInput {
  subjectRef: string;
  reviewedHeadSha: string;
  targetThreadId: string;
  principal: { catId: string; threadId: string; tenantScope: string };
}

export interface CarrierlessLocalReviewFence {
  leaseId: string;
  generation: number;
}

export type CarrierlessLocalReviewPreflightResult =
  | {
      outcome: 'resolved';
      leaseId: string;
      generation: number;
      predecessorCatId: string;
      predecessorThreadId: string;
    }
  | { outcome: 'mismatch' | 'insufficient' | 'stale'; reason: string };

type ResolvedCarrierlessLocalReview = Extract<CarrierlessLocalReviewPreflightResult, { outcome: 'resolved' }> & {
  lease: ActionSuccessorLease;
};

type StructuredPredecessorLease = ActionSuccessorLease & {
  predecessorCatId: string;
  predecessorThreadId: string;
};

export function hasStructuredPredecessor(lease: ActionSuccessorLease): lease is StructuredPredecessorLease {
  return Boolean(lease.claimOrigin === 'structured_transfer' && lease.predecessorCatId && lease.predecessorThreadId);
}

type CarrierlessLocalReviewRejection = Exclude<CarrierlessLocalReviewPreflightResult, { outcome: 'resolved' }>;

function validateCarrierlessPrincipal(
  lease: ActionSuccessorLease,
  input: CarrierlessLocalReviewInput,
  subjectRef: string,
  reviewerCatId: string | undefined,
): CarrierlessLocalReviewRejection | undefined {
  if (lease.tenantScope !== input.principal.tenantScope || lease.subjectRef !== subjectRef) {
    return { outcome: 'mismatch', reason: 'local review identity does not match the canonical lease' };
  }
  if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
    return { outcome: 'mismatch', reason: 'action lease is not local review custody' };
  }
  if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !reviewerCatId) {
    return { outcome: 'mismatch', reason: 'carrier-free local review requires one review holder' };
  }
  if (reviewerCatId !== input.principal.catId) {
    return { outcome: 'mismatch', reason: 'local review caller is not the canonical lease holder' };
  }
  return lease.holderThreadId === input.principal.threadId
    ? undefined
    : { outcome: 'mismatch', reason: 'local review caller thread does not match the canonical lease holder' };
}

function validateCarrierlessRouteAndFence(
  lease: StructuredPredecessorLease,
  input: CarrierlessLocalReviewInput,
  expectedFence: CarrierlessLocalReviewFence | undefined,
): CarrierlessLocalReviewRejection | undefined {
  if (lease.predecessorThreadId !== input.targetThreadId) {
    return { outcome: 'mismatch', reason: 'local review terminal target does not match the predecessor route' };
  }
  if (expectedFence && lease.leaseId !== expectedFence.leaseId) {
    return { outcome: 'stale', reason: 'stale_lease' };
  }
  return expectedFence && lease.generation !== expectedFence.generation
    ? { outcome: 'stale', reason: 'stale_generation' }
    : undefined;
}

function validateCarrierlessPredicateAndStatus(
  lease: ActionSuccessorLease,
  reviewedHeadSha: string,
  reviewerCatId: string,
): CarrierlessLocalReviewRejection | undefined {
  if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
    return { outcome: 'insufficient', reason: 'review delivery predicate unavailable' };
  }
  if (lease.terminalPredicate.headSha !== reviewedHeadSha) {
    return { outcome: 'stale', reason: 'reviewed_head_mismatch' };
  }
  const completedReplay = lease.status === 'completed' && lease.holderOutcomes[reviewerCatId]?.outcome === 'succeeded';
  return lease.status === 'active' || completedReplay ? undefined : { outcome: 'stale', reason: 'lease_not_active' };
}

/** Resolve one active or exact completed-replay review generation through the canonical identity index. */
export async function resolveCarrierlessLocalReview(
  leaseStore: Pick<ActionSuccessorLeaseStore, 'getByIdentity'>,
  input: CarrierlessLocalReviewInput,
  expectedFence?: CarrierlessLocalReviewFence,
): Promise<ResolvedCarrierlessLocalReview | Exclude<CarrierlessLocalReviewPreflightResult, { outcome: 'resolved' }>> {
  let subjectRef: string;
  try {
    subjectRef = canonicalizeActionSubjectRef(input.subjectRef);
  } catch {
    return { outcome: 'mismatch', reason: 'invalid_review_subject' };
  }
  const lease = await leaseStore.getByIdentity({
    tenantScope: input.principal.tenantScope,
    subjectRef,
    actionFamily: 'review',
    successorSlot: 'reviewer',
  });
  if (!lease) return { outcome: 'mismatch', reason: 'canonical_active_review_lease_unavailable' };
  const reviewerCatId = lease.holderCatIds[0];
  const principalRejection = validateCarrierlessPrincipal(lease, input, subjectRef, reviewerCatId);
  if (principalRejection) return principalRejection;
  if (!hasStructuredPredecessor(lease)) {
    return { outcome: 'mismatch', reason: 'local review lease has no structured predecessor route' };
  }
  const routeRejection = validateCarrierlessRouteAndFence(lease, input, expectedFence);
  if (routeRejection) return routeRejection;
  const predicateRejection = validateCarrierlessPredicateAndStatus(lease, input.reviewedHeadSha, input.principal.catId);
  if (predicateRejection) return predicateRejection;
  return {
    outcome: 'resolved',
    lease,
    leaseId: lease.leaseId,
    generation: lease.generation,
    predecessorCatId: lease.predecessorCatId,
    predecessorThreadId: lease.predecessorThreadId,
  };
}
