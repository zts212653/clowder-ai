import type { WaitTerminationActor, WaitTerminationReason } from './wait-termination.js';

export type WaitOwnerFence =
  | { readonly kind: 'containing_task'; readonly generation: number }
  | {
      readonly kind: 'action_successor';
      readonly leaseId: string;
      readonly generation: number;
    };

/**
 * Immutable transport projection for one canonical wait outcome.
 *
 * The containing task or action-successor lease remains authoritative. This
 * value only lets Message/Queue/Invocation retain which exact owner fence
 * authorized the one-shot continuation.
 */
export interface WaitContinuationCarrierV1 {
  readonly v: 1;
  readonly waitId: string;
  readonly outcomeId: string;
  readonly ownerFence: WaitOwnerFence;
}

export interface UnifiedAwaitStateV1<SubjectRef extends string, Baseline, Predicate> {
  readonly v: 1;
  readonly generation: number;
  readonly subjectRef: SubjectRef;
  readonly ownerFence: WaitOwnerFence;
  readonly baseline: Baseline;
  readonly continuation: {
    readonly when: readonly Predicate[];
    readonly then: string;
  };
  /**
   * Optional absolute deadline. Omitted means no time-based termination. A supplied deadline is a
   * loud terminal outcome and is not extended by renewal.
   */
  readonly expiresAt?: number;
  /** Default true for renewable domains; false is the explicit single-fire opt-in. */
  readonly autoRenew?: boolean;
  readonly createdAt: number;
}

export type WaitOutcomeDelivery = 'pending' | 'delivered' | 'not_applicable' | 'legacy_unfenced';

export interface WaitOutcomeBaseV1<SubjectRef extends string> {
  readonly v: 1;
  readonly outcomeId: string;
  readonly generation: number;
  readonly subjectRef: SubjectRef;
  /** Exact owner fence consumed by this outcome; never reconstructed from mutable task fields. */
  readonly ownerFence: WaitOwnerFence;
  readonly reason: WaitTerminationReason;
  readonly at: number;
  readonly delivery: WaitOutcomeDelivery;
  readonly nextStep?: string;
  readonly actor?: WaitTerminationActor;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function parseWaitOwnerFence(value: unknown): WaitOwnerFence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'containing_task' &&
    hasExactKeys(candidate, ['kind', 'generation']) &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) > 0
  ) {
    return Object.freeze({ kind: 'containing_task', generation: candidate.generation as number });
  }
  if (
    candidate.kind === 'action_successor' &&
    hasExactKeys(candidate, ['kind', 'leaseId', 'generation']) &&
    typeof candidate.leaseId === 'string' &&
    candidate.leaseId.length > 0 &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) > 0
  ) {
    return Object.freeze({
      kind: 'action_successor',
      leaseId: candidate.leaseId,
      generation: candidate.generation as number,
    });
  }
  return null;
}

export function parseWaitContinuationCarrier(value: unknown): WaitContinuationCarrierV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactKeys(candidate, ['v', 'waitId', 'outcomeId', 'ownerFence']) ||
    candidate.v !== 1 ||
    typeof candidate.waitId !== 'string' ||
    candidate.waitId.length === 0 ||
    typeof candidate.outcomeId !== 'string' ||
    candidate.outcomeId.length === 0
  ) {
    return null;
  }
  const ownerFence = parseWaitOwnerFence(candidate.ownerFence);
  if (!ownerFence) return null;
  return Object.freeze({
    v: 1,
    waitId: candidate.waitId,
    outcomeId: candidate.outcomeId,
    ownerFence,
  });
}

export function createWaitContinuationCarrier(
  waitId: string,
  outcome: { readonly outcomeId: string; readonly ownerFence: WaitOwnerFence },
): WaitContinuationCarrierV1 {
  const carrier = parseWaitContinuationCarrier({
    v: 1,
    waitId,
    outcomeId: outcome.outcomeId,
    ownerFence: outcome.ownerFence,
  });
  if (!carrier) throw new Error('canonical wait outcome cannot produce a valid continuation carrier');
  return carrier;
}
