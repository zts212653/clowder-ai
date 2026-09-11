/**
 * Liveness policy for a Queue that is holding entries but running nothing.
 *
 * Explain why a continuation attempt started nothing while the strict Queue
 * head remains pending.
 */

export type ContinuationOutcome = 'no_dispatchable_candidate' | 'all_candidate_slots_busy' | 'start_rejected';

export const CONTINUATION_DIAGNOSTIC_MESSAGE = '[QueueProcessor] continuation started nothing while entries are queued';

export interface ContinuationDiagnostic {
  readonly payload: {
    readonly threadId: string;
    readonly catId: string;
    readonly outcome: ContinuationOutcome;
    readonly deferredForBusySlot: number;
    readonly entryId?: string;
  };
  readonly message: string;
}

/**
 * Describe a continuation attempt that started nothing, or `null` when the
 * thread has nothing queued — an empty queue needs no excuse.
 *
 * `hasDispatchableQueued` is the required truth here rather than a freshness-
 * sensitive "has queued" predicate: the latter reports false for non-agent
 * entries past the stale threshold, which is exactly the "a user message has
 * been sitting for minutes" case this diagnostic exists to explain.
 */
export function describeContinuationOutcome(input: {
  threadId: string;
  catId: string;
  outcome: ContinuationOutcome;
  deferredForBusySlot: number;
  entryId?: string;
  hasDispatchableQueued: boolean;
}): ContinuationDiagnostic | null {
  if (!input.hasDispatchableQueued) return null;
  return {
    payload: {
      threadId: input.threadId,
      catId: input.catId,
      outcome: input.outcome,
      deferredForBusySlot: input.deferredForBusySlot,
      ...(input.entryId ? { entryId: input.entryId } : {}),
    },
    message: CONTINUATION_DIAGNOSTIC_MESSAGE,
  };
}

/** Which of the three outcomes a scan that started nothing actually hit. */
export function classifyContinuationOutcome(deferredForBusySlot: number): ContinuationOutcome {
  return deferredForBusySlot > 0 ? 'all_candidate_slots_busy' : 'no_dispatchable_candidate';
}
