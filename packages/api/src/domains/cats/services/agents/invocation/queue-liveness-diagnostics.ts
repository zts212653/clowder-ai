/**
 * Liveness policy for a Queue that is holding entries but running nothing.
 *
 * Both halves answer the operator question "there are messages, why is nothing
 * happening?" — one decides whether a restored entry may be parked, the other
 * explains why a continuation attempt started nothing. They live together and
 * outside QueueProcessor so this policy stays readable and testable on its own.
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

/**
 * Whether a restored entry may still be parked once the preview I/O has
 * finished.
 *
 * Preparing the paused projection is real I/O, and a replacement owner can take
 * the slot while it runs. Committing the pause afterwards would park a turn that
 * has already moved on, so supersession must be re-checked after the await —
 * not only before it.
 */
export function mayCommitPause(input: {
  supersededByReplacement: boolean;
  stillHasDispatchableQueued: boolean;
}): boolean {
  return !input.supersededByReplacement && input.stillHasDispatchableQueued;
}

export interface ParkRequeuedEntryPort<TNotification> {
  hasDispatchableQueued(): boolean;
  isSupersededByReplacement(invocationId: string): boolean;
  prepareNotifications(): Promise<TNotification[]>;
  commitPause(reason: 'canceled' | 'failed', notifications: readonly TNotification[]): void;
}

/**
 * Make a restored-but-not-restarted Queue entry observable.
 *
 * A user cancel deliberately does not restart the entry — an interrupt must not
 * be silently undone — but skipping the pause bookkeeping too left the slot
 * reporting idle while the entry sat in Queue. The pause vocabulary is coarser
 * than the completion vocabulary, so a user cancel parks under `canceled`.
 */
export async function parkRequeuedEntryVisibly<TNotification>(
  input: {
    threadId: string;
    catId: string;
    status: 'failed' | 'canceled' | 'canceled_by_user';
    invocationId: string | undefined;
  },
  port: ParkRequeuedEntryPort<TNotification>,
): Promise<void> {
  if (!port.hasDispatchableQueued()) return;
  const reason = input.status === 'failed' ? 'failed' : 'canceled';
  const notifications = await port.prepareNotifications();
  if (
    !mayCommitPause({
      supersededByReplacement: input.invocationId !== undefined && port.isSupersededByReplacement(input.invocationId),
      stillHasDispatchableQueued: port.hasDispatchableQueued(),
    })
  ) {
    return;
  }
  port.commitPause(reason, notifications);
}
