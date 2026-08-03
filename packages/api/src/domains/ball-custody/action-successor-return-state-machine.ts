import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export const ACTION_SUCCESSOR_RETURN_DELIVERY_SLA_MS = 60_000;

export type ActionSuccessorReturnDeliveryState = 'pending' | 'overdue' | 'delivered';

export interface ActionSuccessorReturnTransition {
  outcome: 'rejected_ownership';
  fromGeneration: number;
  toGeneration: number;
  rejectingCatId: string;
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
