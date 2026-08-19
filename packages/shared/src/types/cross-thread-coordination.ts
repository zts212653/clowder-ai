/** F167 Phase R: explicit cross-thread coordination lifecycle. */
export type CrossThreadCoordinationInputPhase = 'active' | 'terminal';

/** Caller-supplied transition. `id` is normally omitted and server-derived. */
export interface CrossThreadCoordinationInput {
  phase: CrossThreadCoordinationInputPhase;
  id?: string;
  /** Stable action subject. A changed subject starts a fresh coordination generation. */
  subjectRef?: string;
}

/** Persistent lifecycle projection carried independently by StoredMessage.extra.coordination. */
export interface CrossThreadCoordination {
  id: string;
  phase: CrossThreadCoordinationInputPhase | 'ack';
  /** Lineage hint only; ordering truth remains the message id/timestamp. */
  hop: number;
  /** Optional action identity binding; absent on legacy/general-purpose chains. */
  subjectRef?: string;
}

/**
 * Cross-thread provenance exists only when both endpoints are known and distinct.
 * Coordination state is intentionally not part of this predicate: a lifecycle may
 * continue inside one thread without inventing a cross-thread source edge.
 */
export function isCrossThreadProvenance(
  sourceThreadId: string | null | undefined,
  targetThreadId: string | null | undefined,
): sourceThreadId is string {
  return Boolean(sourceThreadId && targetThreadId && sourceThreadId !== targetThreadId);
}
