import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export const ACTION_SUCCESSOR_RETURN_DELIVERY_SLA_MS = 60_000;

export type ActionSuccessorReturnDeliveryState = 'pending' | 'overdue' | 'delivered';

export interface ActionSuccessorReturnTransition {
  outcome: 'rejected_ownership';
  fromGeneration: number;
  toGeneration: number;
  rejectingCatId: string;
  /** Optional for rolling compatibility with transitions written before F167 returned reentry. */
  rejectingThreadId?: string;
  predecessorCatId: string;
  predecessorThreadId: string;
  groundingEvidenceRef: string;
  at: number;
}

export type ReturnActionSuccessorResult = {
  outcome:
    | 'returned'
    | 'replayed'
    | 'stale_generation'
    | 'lease_not_active'
    | 'holder_mismatch'
    | 'predecessor_missing'
    | 'parallel_return_unsupported';
  lease: ActionSuccessorLease;
};

export interface ReturnActionSuccessorInput {
  expectedGeneration: number;
  rejectingCatId: string;
  rejectingThreadId: string;
  dispatchId: string;
  groundingEvidenceRef: string;
  now: number;
}

export type ReturnedActionSuccessorProof =
  | { kind: 'returned_fence'; leaseId: string; generation: number }
  | { kind: 'return_delivery'; evidenceRef: string };

export interface ReattachReturnedActionSuccessorInput {
  expectedGeneration: number;
  holderCatIds: string[];
  holderThreadId: string;
  dispatchId: string;
  terminalPredicate: CanonicalActionTerminalPredicate;
  evidenceRef: string;
  freshnessEvidenceRef: string;
  returnedHolderCatId: string;
  returnedHolderThreadId: string;
  returnProof: ReturnedActionSuccessorProof;
  now: number;
}

export type ReattachReturnedActionSuccessorResult = {
  outcome:
    | 'reattached'
    | 'stale_generation'
    | 'holder_mismatch'
    | 'return_proof_required'
    | 'candidate_present'
    | 'completion_present'
    | 'terminal_predicate_mismatch';
  lease: ActionSuccessorLease;
};

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

export function returnActionSuccessorToPredecessor(
  current: ActionSuccessorLease,
  input: ReturnActionSuccessorInput,
): ReturnActionSuccessorResult {
  if (isActionSuccessorReturnReplay(current, input)) return { outcome: 'replayed', lease: current };
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
  const rejectingCatId = input.rejectingCatId.trim();
  const rejectingThreadId = input.rejectingThreadId.trim();
  const groundingEvidenceRef = requireNonEmpty(input.groundingEvidenceRef, 'groundingEvidenceRef');
  if (current.mode === 'parallel') {
    if (!current.holderCatIds.includes(rejectingCatId) || current.holderThreadId !== rejectingThreadId) {
      return { outcome: 'holder_mismatch', lease: current };
    }
    return {
      outcome: 'parallel_return_unsupported',
      lease: recordActionSuccessorOutcome(current, {
        generation: current.generation,
        catId: rejectingCatId,
        outcome: 'rejected_ownership',
        evidenceRef: groundingEvidenceRef,
        now: input.now,
      }),
    };
  }
  if (!current.predecessorCatId || !current.predecessorThreadId) {
    return { outcome: 'predecessor_missing', lease: current };
  }
  if (current.holderCatIds[0] !== rejectingCatId || current.holderThreadId !== rejectingThreadId) {
    return { outcome: 'holder_mismatch', lease: current };
  }
  const dispatchId = requireNonEmpty(input.dispatchId, 'dispatchId');
  const toGeneration = current.generation + 1;
  const transition: ActionSuccessorReturnTransition = {
    outcome: 'rejected_ownership',
    fromGeneration: current.generation,
    toGeneration,
    rejectingCatId,
    rejectingThreadId,
    predecessorCatId: current.predecessorCatId,
    predecessorThreadId: current.predecessorThreadId,
    groundingEvidenceRef,
    at: input.now,
  };
  return {
    outcome: 'returned',
    lease: {
      ...current,
      holderCatIds: [current.predecessorCatId],
      holderThreadId: current.predecessorThreadId,
      predecessorCatId: rejectingCatId,
      predecessorThreadId: rejectingThreadId,
      issuerStandingEvidenceRef: groundingEvidenceRef,
      dispatchId,
      claimOrigin: 'structured_transfer',
      generation: toGeneration,
      status: 'active',
      holderOutcomes: {},
      completionCandidates: {},
      evidenceRefs: [...new Set([...current.evidenceRefs, groundingEvidenceRef])],
      returnDeliveryState: 'pending',
      returnDeliveryEvidenceRef: groundingEvidenceRef,
      returnDeliveryAttemptCount: 0,
      returnDeliverySlaUntil: input.now + ACTION_SUCCESSOR_RETURN_DELIVERY_SLA_MS,
      returnDeliveryLastAttemptAt: undefined,
      returnDeliveryOverdueObservedAt: undefined,
      returnTransitions: [...current.returnTransitions, transition],
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}

export function isReturnedActionSuccessorHolderGeneration(current: ActionSuccessorLease): boolean {
  const transition = (current.returnTransitions ?? []).at(-1);
  if (!transition || current.mode !== 'single') return false;
  return (
    transition.toGeneration === current.generation &&
    current.holderCatIds.length === 1 &&
    current.holderCatIds[0] === transition.predecessorCatId &&
    current.holderThreadId === transition.predecessorThreadId &&
    current.predecessorCatId === transition.rejectingCatId &&
    Boolean(current.predecessorThreadId) &&
    (transition.rejectingThreadId === undefined || transition.rejectingThreadId === current.predecessorThreadId)
  );
}

function hasExactReturnProof(current: ActionSuccessorLease, proof: ReturnedActionSuccessorProof): boolean {
  if (proof.kind === 'returned_fence') {
    return proof.leaseId === current.leaseId && proof.generation === current.generation;
  }
  return (
    current.returnDeliveryState === 'delivered' &&
    current.returnDeliveryEvidenceRef === proof.evidenceRef &&
    current.evidenceRefs.includes(proof.evidenceRef)
  );
}

export function reattachReturnedActionSuccessor(
  current: ActionSuccessorLease,
  input: ReattachReturnedActionSuccessorInput,
): ReattachReturnedActionSuccessorResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  const transition = (current.returnTransitions ?? []).at(-1);
  if (
    !transition ||
    !isReturnedActionSuccessorHolderGeneration(current) ||
    input.returnedHolderCatId.trim() !== transition.predecessorCatId ||
    input.returnedHolderThreadId.trim() !== transition.predecessorThreadId ||
    current.holderCatIds[0] !== input.returnedHolderCatId.trim() ||
    current.holderThreadId !== input.returnedHolderThreadId.trim()
  ) {
    return { outcome: 'holder_mismatch', lease: current };
  }
  if (Object.keys(current.completionCandidates).length > 0) {
    return { outcome: 'candidate_present', lease: current };
  }
  if (current.status !== 'active' || Object.keys(current.holderOutcomes).length > 0) {
    return { outcome: 'completion_present', lease: current };
  }
  if (!hasExactReturnProof(current, input.returnProof)) {
    return { outcome: 'return_proof_required', lease: current };
  }
  if (!current.terminalPredicate || current.terminalPredicate.identityKey !== input.terminalPredicate.identityKey) {
    return { outcome: 'terminal_predicate_mismatch', lease: current };
  }
  const holderCatIds = [...new Set(input.holderCatIds.map((catId) => catId.trim()).filter(Boolean))];
  if (holderCatIds.length !== 1 || holderCatIds.length !== input.holderCatIds.length) {
    throw new Error('single mode requires exactly one unique non-empty holder');
  }
  const holderThreadId = requireNonEmpty(input.holderThreadId, 'holderThreadId');
  const dispatchId = requireNonEmpty(input.dispatchId, 'dispatchId');
  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  const freshnessEvidenceRef = requireNonEmpty(input.freshnessEvidenceRef, 'freshnessEvidenceRef');
  const returnProofEvidenceRef =
    input.returnProof.kind === 'return_delivery' ? input.returnProof.evidenceRef : undefined;
  return {
    outcome: 'reattached',
    lease: {
      ...current,
      holderCatIds,
      holderThreadId,
      predecessorCatId: input.returnedHolderCatId.trim(),
      predecessorThreadId: input.returnedHolderThreadId.trim(),
      issuerStandingEvidenceRef: evidenceRef,
      dispatchId,
      terminalPredicateState: { kind: 'predicate_backed' },
      terminalPredicate: input.terminalPredicate,
      generation: current.generation + 1,
      status: 'active',
      holderOutcomes: {},
      completionCandidates: {},
      evidenceRefs: [
        ...new Set([
          ...current.evidenceRefs,
          current.issuerStandingEvidenceRef,
          transition.groundingEvidenceRef,
          evidenceRef,
          freshnessEvidenceRef,
          ...(returnProofEvidenceRef ? [returnProofEvidenceRef] : []),
        ]),
      ],
      returnDeliveryState: undefined,
      returnDeliveryEvidenceRef: undefined,
      returnDeliveryAttemptCount: undefined,
      returnDeliverySlaUntil: undefined,
      returnDeliveryLastAttemptAt: undefined,
      returnDeliveryOverdueObservedAt: undefined,
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}

export function isActionSuccessorReturnReplay(
  current: ActionSuccessorLease,
  input: Omit<ReturnActionSuccessorInput, 'now'>,
): boolean {
  const transition = (current.returnTransitions ?? []).at(-1);
  if (!transition) return false;
  const rejectingCatId = input.rejectingCatId.trim();
  const rejectingThreadId = input.rejectingThreadId.trim();
  return (
    current.generation === input.expectedGeneration + 1 &&
    current.dispatchId === input.dispatchId.trim() &&
    current.predecessorCatId === rejectingCatId &&
    current.predecessorThreadId === rejectingThreadId &&
    current.holderCatIds.length === 1 &&
    current.holderCatIds[0] === transition.predecessorCatId &&
    current.holderThreadId === transition.predecessorThreadId &&
    transition.fromGeneration === input.expectedGeneration &&
    transition.toGeneration === current.generation &&
    transition.rejectingCatId === rejectingCatId &&
    transition.groundingEvidenceRef === input.groundingEvidenceRef.trim()
  );
}

export type MarkActionSuccessorReturnDeliveredResult = {
  outcome: 'delivered' | 'stale_generation' | 'return_not_pending';
  lease: ActionSuccessorLease;
};

export type RecordActionSuccessorReturnDeliveryAttemptResult = {
  outcome: 'recorded' | 'stale_generation' | 'return_not_pending';
  lease: ActionSuccessorLease;
  becameOverdue?: boolean;
};

export function recordActionSuccessorReturnDeliveryAttempt(
  current: ActionSuccessorLease,
  input: { expectedGeneration: number; now: number },
): RecordActionSuccessorReturnDeliveryAttemptResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (current.returnDeliveryState !== 'pending' && current.returnDeliveryState !== 'overdue') {
    return { outcome: 'return_not_pending', lease: current };
  }
  const slaUntil = current.returnDeliverySlaUntil ?? current.updatedAt + ACTION_SUCCESSOR_RETURN_DELIVERY_SLA_MS;
  const becameOverdue = current.returnDeliveryState === 'pending' && input.now >= slaUntil;
  return {
    outcome: 'recorded',
    becameOverdue,
    lease: {
      ...current,
      returnDeliveryState: becameOverdue ? 'overdue' : current.returnDeliveryState,
      returnDeliveryAttemptCount: (current.returnDeliveryAttemptCount ?? 0) + 1,
      returnDeliverySlaUntil: slaUntil,
      returnDeliveryLastAttemptAt: input.now,
      ...(becameOverdue ? { returnDeliveryOverdueObservedAt: input.now } : {}),
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}

export function markActionSuccessorReturnDelivered(
  current: ActionSuccessorLease,
  input: { expectedGeneration: number; evidenceRef: string; now: number },
): MarkActionSuccessorReturnDeliveredResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (current.returnDeliveryState !== 'pending' && current.returnDeliveryState !== 'overdue') {
    return { outcome: 'return_not_pending', lease: current };
  }
  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  return {
    outcome: 'delivered',
    lease: {
      ...current,
      returnDeliveryState: 'delivered',
      returnDeliveryEvidenceRef: evidenceRef,
      evidenceRefs: [...new Set([...current.evidenceRefs, evidenceRef])],
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}
