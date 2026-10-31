import type { BallCustodyEvent } from '@cat-cafe/shared';
import { handedEventSourceId, type ManagedHoldRetiredReason } from './ball-custody-events.js';
import { replayBallCustodyProjection } from './ball-custody-projection-reducer.js';
import { findSupersedingEvent } from './managed-hold-supersession.js';

/**
 * What one event-wait wake IS: the cat it was delivered to and the exact wait + outcome its carrier names.
 *
 * `outcomeId` alone is not an identity. A deployment wait's outcome is `wait:<subjectRef>:g<generation>:matched`, so two
 * independent Tasks waiting on the same deployment share it and differ only in `waitId` (the Task id). Both are part of
 * the identity, and the invocation that happens to settle the wake never is.
 */
export interface EventWaitWakeIdentity {
  readonly catId: string;
  readonly waitId: string;
  readonly outcomeId: string;
}

/**
 * Single source of truth for the event-wait protocol's per-wake facts.
 *
 * The producer (EventWaitDispositionService) and the stop-gate consumer (TurnCustodyProjectionService) must answer
 * "is this wake already settled?" identically: when the writer and the reader each decided for themselves, a wake could
 * be undischargeable on one side while still blocking on the other (the hold protocol's #1366 liveness loop).
 */

/** Any terminal already recorded for this exact wake, regardless of which invocation wrote it. */
export function findEventWaitTerminal(
  events: readonly BallCustodyEvent[],
  wake: EventWaitWakeIdentity,
): BallCustodyEvent | undefined {
  return events.find(
    (event) =>
      event.kind === 'ball.wait_dispositioned' &&
      event.payload.catId === wake.catId &&
      event.payload.waitId === wake.waitId &&
      event.payload.outcomeId === wake.outcomeId,
  );
}

/** Index of the exact handoff that delivered this wake message to this cat, or -1. */
export function eventWaitReceiverHandoffIndex(
  events: readonly BallCustodyEvent[],
  wakeMessageId: string,
  catId: string,
): number {
  const sourceEventId = handedEventSourceId(wakeMessageId, catId);
  return events.findIndex((event) => event.kind === 'ball.handed' && event.sourceEventId === sourceEventId);
}

export type EventWaitWakeState =
  /** The cat still holds the ball this wake handed it: completing it advances the subject. */
  | { readonly kind: 'live' }
  /** The wake no longer owns the ball: completing it closes this obligation alone and stays inert. */
  | { readonly kind: 'retired'; readonly reason: ManagedHoldRetiredReason };

/**
 * Live or retired, replayed from the SAME log snapshot a fenced append is checked against (never the projection cache,
 * which can trail the log).
 *
 * `superseded` is the specific verdict and wins: a LATER ACCEPTED custody source (a new hold, a hand-off away, a new
 * hand-off to the cat) replaced what this wake delivered, so settling the old wake must not end the ball that replacement
 * now carries. Only a custody event the state machine accepted counts; a rejected one, or an FYI that moved nothing, did
 * not take the ball. Otherwise `subject_resolved` (the subject ended) is more specific than `ball_not_held`.
 */
export function classifyEventWaitWake(
  events: readonly BallCustodyEvent[],
  input: { readonly catId: string; readonly receiverHandoffIndex: number; readonly wakeMessageId: string },
): EventWaitWakeState {
  const superseding = findSupersedingEvent(events, {
    afterIndex: input.receiverHandoffIndex,
    scanEnd: events.length,
    catId: input.catId,
    ownReceiverHandoffSourceId: handedEventSourceId(input.wakeMessageId, input.catId),
  });
  if (superseding) return { kind: 'retired', reason: 'superseded' };

  const projection = replayBallCustodyProjection(events);
  if (projection?.state === 'resolved') return { kind: 'retired', reason: 'subject_resolved' };
  const holdsBall =
    (projection?.state === 'active' || projection?.state === 'blocked') && projection.holder === input.catId;
  return holdsBall ? { kind: 'live' } : { kind: 'retired', reason: 'ball_not_held' };
}
