import type { ActionSuccessorHolderOutcome, ActionSuccessorLease } from './action-successor-state-machine.js';

export interface RetirePendingDispatchForFreshnessMismatchInput {
  generation: number;
  expectedRevision: number;
  expectedPredicateDigest: string;
  evidenceRef: string;
  now: number;
}

export type RetirePendingDispatchForFreshnessMismatchResult = {
  outcome:
    | 'retired'
    | 'stale_generation'
    | 'stale_revision'
    | 'predicate_mismatch'
    | 'dispatch_not_pending'
    | 'dispatch_reserved'
    | 'lease_not_active'
    | 'holder_terminal';
  lease: ActionSuccessorLease;
};

export function recordActionSuccessorOutcome(
  current: ActionSuccessorLease,
  input: {
    generation: number;
    catId: string;
    outcome: ActionSuccessorHolderOutcome;
    evidenceRef: string;
    now: number;
  },
): ActionSuccessorLease {
  if (input.generation !== current.generation) throw new Error('stale action successor generation');
  if (!current.holderCatIds.includes(input.catId))
    throw new Error(`cat is not an action successor holder: ${input.catId}`);
  if (current.status !== 'active') return current;
  // First terminal observation wins. In a parallel lease another holder can
  // keep the lease active while timeout/cleanup races with a completed holder;
  // overwriting that holder would corrupt the proof used for final status.
  if (current.holderOutcomes[input.catId]) return current;
  const holderOutcomes = {
    ...current.holderOutcomes,
    [input.catId]: { outcome: input.outcome, evidenceRef: input.evidenceRef, at: input.now },
  };
  const allTerminal = current.holderCatIds.every((catId) => holderOutcomes[catId] !== undefined);
  const anySucceeded = Object.values(holderOutcomes).some((entry) => entry.outcome === 'succeeded');
  const completionCandidates = { ...current.completionCandidates };
  delete completionCandidates[input.catId];
  return {
    ...current,
    holderOutcomes,
    completionCandidates,
    status: allTerminal ? (anySucceeded ? 'completed' : 'replaceable') : 'active',
    evidenceRefs: [...new Set([...current.evidenceRefs, input.evidenceRef])],
    revision: current.revision + 1,
    updatedAt: input.now,
  };
}

/**
 * Retire a pending carrier whose frozen responsibility no longer matches
 * server-owned subject truth. Dispatch failure and every unavailable holder
 * outcome are one lease revision so replacement can never observe a stranded
 * active generation between those facts.
 */
export function retirePendingDispatchForFreshnessMismatch(
  current: ActionSuccessorLease,
  input: RetirePendingDispatchForFreshnessMismatchInput,
): RetirePendingDispatchForFreshnessMismatchResult {
  if (input.generation !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (current.terminalPredicate?.digest !== input.expectedPredicateDigest) {
    return { outcome: 'predicate_mismatch', lease: current };
  }
  if (current.revision !== input.expectedRevision) return { outcome: 'stale_revision', lease: current };
  if (current.dispatchDeliveryState !== 'pending') return { outcome: 'dispatch_not_pending', lease: current };
  if (current.dispatchDeliveryReservation) return { outcome: 'dispatch_reserved', lease: current };
  if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
  if (Object.keys(current.holderOutcomes).length > 0) return { outcome: 'holder_terminal', lease: current };

  const evidenceRef = input.evidenceRef.trim();
  if (!evidenceRef) throw new Error('freshness mismatch retirement requires an evidence identity');
  const holderOutcomes = Object.fromEntries(
    current.holderCatIds.map((catId) => [catId, { outcome: 'unavailable' as const, evidenceRef, at: input.now }]),
  );
  return {
    outcome: 'retired',
    lease: {
      ...current,
      status: 'replaceable',
      holderOutcomes,
      completionCandidates: {},
      dispatchDeliveryState: 'failed',
      dispatchFailureReason: 'terminal_predicate_mismatch',
      dispatchFailureEvidenceRef: evidenceRef,
      evidenceRefs: [...new Set([...current.evidenceRefs, evidenceRef])],
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}
