/**
 * External review recovery state machine — the external counterpart to
 * recoverActiveLocalReviewVerdict.
 *
 * Settles one active stale-HEAD generation when:
 * 1. The external review WAS conducted (persisted GitHub review artifact)
 * 2. The PR HEAD has advanced past the reviewed HEAD (stale_head on record)
 * 3. The lease generation is active and untouched
 *
 * The predecessor (author) calls to settle the old generation so a new review
 * can be dispatched for the current HEAD. Every structural recovery guard is
 * repeated at the CAS boundary so concurrent output cannot be overwritten.
 *
 * F167: stale-external-review-recovery
 */

import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface RecoverActiveExternalReviewVerdictInput {
  expectedGeneration: number;
  reviewerCatId: string;
  predecessorCatId: string;
  predecessorThreadId: string;
  tenantScope: string;
  headSha: string;
  evidenceRef: string;
  now: number;
}

export type RecoverActiveExternalReviewVerdictResult =
  | { outcome: 'recovered'; lease: ActionSuccessorLease }
  | { outcome: 'replayed'; lease: ActionSuccessorLease }
  | {
      outcome:
        | 'stale_generation'
        | 'lease_not_active'
        | 'identity_mismatch'
        | 'holder_mismatch'
        | 'predecessor_mismatch'
        | 'output_present'
        | 'candidate_present'
        | 'return_present';
      lease: ActionSuccessorLease;
    };

/**
 * Atomic lease transition for external review recovery. Structurally identical
 * to recoverActiveLocalReviewVerdict — same identity/holder/generation/untouched
 * guards. The difference is upstream: the service verifies a GitHub review
 * artifact instead of a local message, and requires a server-observed HEAD
 * advance (freshness mismatch) instead of a local message store lookup.
 */
export function recoverActiveExternalReviewVerdict(
  current: ActionSuccessorLease,
  input: RecoverActiveExternalReviewVerdictInput,
): RecoverActiveExternalReviewVerdictResult {
  if (current.generation !== input.expectedGeneration) {
    return { outcome: 'stale_generation', lease: current };
  }
  if (
    current.actionFamily !== 'review' ||
    current.successorSlot !== 'reviewer' ||
    current.mode !== 'single' ||
    current.claimOrigin !== 'structured_transfer' ||
    current.terminalPredicate?.kind !== 'review_delivered' ||
    current.terminalPredicate.headSha !== input.headSha
  ) {
    return { outcome: 'identity_mismatch', lease: current };
  }
  if (current.holderCatIds.length !== 1 || current.holderCatIds[0] !== input.reviewerCatId) {
    return { outcome: 'holder_mismatch', lease: current };
  }
  if (
    current.predecessorCatId !== input.predecessorCatId ||
    current.predecessorThreadId !== input.predecessorThreadId ||
    current.tenantScope !== input.tenantScope
  ) {
    return { outcome: 'predecessor_mismatch', lease: current };
  }
  if (current.status === 'completed') {
    const settled = current.holderOutcomes[input.reviewerCatId];
    return settled?.outcome === 'succeeded' && settled.evidenceRef === input.evidenceRef
      ? { outcome: 'replayed', lease: current }
      : { outcome: 'lease_not_active', lease: current };
  }
  if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
  if (Object.keys(current.holderOutcomes).length > 0) return { outcome: 'output_present', lease: current };
  if (Object.keys(current.completionCandidates).length > 0) return { outcome: 'candidate_present', lease: current };
  if (current.returnTransitions.length > 0) return { outcome: 'return_present', lease: current };

  return {
    outcome: 'recovered',
    lease: recordActionSuccessorOutcome(current, {
      generation: input.expectedGeneration,
      catId: input.reviewerCatId,
      outcome: 'succeeded',
      evidenceRef: input.evidenceRef,
      now: input.now,
    }),
  };
}
