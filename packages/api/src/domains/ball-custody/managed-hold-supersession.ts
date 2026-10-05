import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { BallEventOutcome } from './ball-custody-projection-reducer.js';
import { replayBallCustodyOutcomes } from './ball-custody-projection-reducer.js';
import type { TurnCustodyProjection, TurnCustodyWakeProvenance } from './turn-custody-projection-types.js';

type StructuredWakeLocator = Extract<TurnCustodyWakeProvenance, { kind: 'structured' }>;

import { handedEventSourceId } from './ball-custody-events.js';

/**
 * Single source of truth for "was this exact managed-hold wake superseded?".
 *
 * F167 × clowder-ai#1366: this predicate previously existed twice — once in
 * ManagedHoldDispositionService.assertWakeNotReplaced (write side) and once
 * implicitly in TurnCustodyProjectionService.openStructured (read side). The two
 * diverged, so a wake could be judged "replaced, refuse to terminate" by the
 * writer while the reader still treated it as a live obligation. That divergence
 * is the liveness loop: undischargeable on one side, still blocking on the other.
 */
export interface ManagedHoldWakeIdentity {
  readonly catId: string;
  readonly sourceMessageId: string;
  readonly taskId: string;
}

export type ManagedHoldSupersession =
  | { readonly kind: 'wake_missing' }
  | { readonly kind: 'live' }
  | { readonly kind: 'superseded'; readonly bySourceEventId: string };

/**
 * Whether one later custody event took the ball away from this wake. Only an event the state machine
 * ACCEPTED can: a rejected event changed nothing, and an accepted one that changed nothing (an FYI
 * hand-off to the operator) did not move custody either.
 */
function supersedesWake(
  event: BallCustodyEvent,
  outcome: BallEventOutcome | undefined,
  wake: ManagedHoldWakeIdentity,
  ownReceiverHandoffSourceId: string,
): boolean {
  if (!outcome?.accepted) return false;
  switch (event.kind) {
    // Any cat: an accepted hold is a new custody source. By the wake cat it is a re-hold; by another
    // cat the ball has moved to that cat.
    case 'ball.held':
      return true;
    // The wake's own receiver hand-off is what delivered it; it is never its own replacement.
    case 'ball.handed':
      return (
        event.sourceEventId !== ownReceiverHandoffSourceId &&
        (event.payload.fromCatId === wake.catId || event.payload.toCatId === wake.catId)
      );
    case 'ball.handed_cvo':
      return outcome.stateChanged && event.payload.fromCatId === wake.catId;
    default:
      return false;
  }
}

/**
 * Locate the exact `ball.wake_condition_met` for this wake, then report whether a
 * later ACCEPTED custody transition took the ball away from it.
 *
 * Acceptance is decided by replaying the event snapshot through the same reducer the projector
 * uses (`replayBallCustodyOutcomes`), never by the materialised projection: that cache can lag the
 * log (events are appended before they are applied), and a predicate built on it would retire a wake
 * that nothing superseded. An event's outcome depends only on the events before it, so reading the
 * snapshot in a single pass is consistent for every `boundarySequence`.
 *
 * `boundarySequence` bounds the scan to events that existed at a given moment.
 * The read side passes its adoption baseline so that a *post*-adoption rehold or
 * handoff is NOT counted as supersession — that is a legitimate continuation
 * witness which the stop gate must still observe through its normal close path.
 */
export function classifyManagedHoldWake(
  events: readonly BallCustodyEvent[],
  wake: ManagedHoldWakeIdentity,
  boundarySequence: number = events.length,
): ManagedHoldSupersession {
  const exactWakeIndex = events.findIndex(
    (event) =>
      event.kind === 'ball.wake_condition_met' &&
      event.payload.taskId === wake.taskId &&
      event.payload.catId === wake.catId,
  );
  if (exactWakeIndex === -1) return { kind: 'wake_missing' };

  const ownReceiverHandoffSourceId = handedEventSourceId(wake.sourceMessageId, wake.catId);
  const scanEnd = Math.min(events.length, Math.max(exactWakeIndex + 1, boundarySequence));
  const outcomes = replayBallCustodyOutcomes(events, scanEnd);
  for (let index = exactWakeIndex + 1; index < scanEnd; index += 1) {
    const event = events[index] as BallCustodyEvent;
    if (supersedesWake(event, outcomes[index], wake, ownReceiverHandoffSourceId)) {
      return { kind: 'superseded', bySourceEventId: event.sourceEventId };
    }
  }
  return { kind: 'live' };
}

/**
 * Read-side projection for an adopted hold wake.
 *
 * Returns evidence refs when the wake was already superseded BEFORE this turn
 * adopted it (so it is not a live obligation and must not block the turn), or
 * `undefined` when it is still live. The boundary is the caller's adoption
 * snapshot, so a rehold/handoff that happens AFTER adoption remains a
 * continuation witness rather than a supersession.
 */
export function supersededBeforeAdoption(
  events: readonly BallCustodyEvent[],
  wake: ManagedHoldWakeIdentity,
  subjectKey: string,
): readonly string[] | undefined {
  const supersession = classifyManagedHoldWake(events, wake, events.length);
  return supersession.kind === 'superseded'
    ? [`hold:${subjectKey}`, `superseded:${supersession.bySourceEventId}`]
    : undefined;
}

/**
 * Any terminal already recorded for this exact wake, regardless of which
 * invocation wrote it.
 *
 * Shared deliberately: the producer uses it for idempotent replay, and the F167
 * stop-gate consumer uses it to recognize a wake that is already settled. Those
 * two answers diverging is the same class of bug this module exists to prevent.
 */
export function findWakeTerminal(
  events: readonly BallCustodyEvent[],
  wake: ManagedHoldWakeIdentity,
): BallCustodyEvent | undefined {
  return events.find(
    (event) =>
      event.kind === 'ball.hold_dispositioned' &&
      event.payload.catId === wake.catId &&
      event.payload.sourceMessageId === wake.sourceMessageId &&
      event.payload.taskId === wake.taskId,
  );
}

/** Index of the exact delivery handoff for this structured wake, or -1. */
export function exactStructuredWakeIndex(wake: StructuredWakeLocator, events: readonly BallCustodyEvent[]): number {
  if (wake.protocol === 'dispatch') {
    return events.findIndex(
      (event) =>
        event.kind === 'ball.handed' &&
        event.sourceEventId === wake.handoff.sourceEventId &&
        event.payload.fromCatId === wake.handoff.fromCatId &&
        event.payload.toCatId === wake.holderCatId,
    );
  }
  if (wake.protocol !== 'hold') return -1;
  const wakeConditionIndex = events.findIndex(
    (event) =>
      event.kind === 'ball.wake_condition_met' &&
      event.payload.taskId === wake.taskId &&
      event.payload.catId === wake.holderCatId,
  );
  if (wakeConditionIndex === -1) return -1;
  return events.findIndex(
    (event, index) =>
      index > wakeConditionIndex &&
      event.kind === 'ball.handed' &&
      event.sourceEventId === handedEventSourceId(wake.sourceMessageId, wake.holderCatId) &&
      event.payload.toCatId === wake.holderCatId,
  );
}

function findRelease(
  events: readonly BallCustodyEvent[],
  exactWakeIndex: number,
  holderCatId: string,
): BallCustodyEvent | undefined {
  return events.slice(exactWakeIndex + 1).find((event) => {
    if (event.kind === 'ball.handed') return event.payload.fromCatId === holderCatId;
    return (
      event.kind === 'ball.handed_cvo' &&
      event.payload.fromCatId === holderCatId &&
      (event.payload.intent === 'handoff' || event.payload.intent === 'done_notify')
    );
  });
}

/** The holder already released this exact wake, so it is no longer an obligation. */
export function releasedStructuredWake(
  wake: StructuredWakeLocator,
  events: readonly BallCustodyEvent[],
  exactWakeIndex: number,
): TurnCustodyProjection | undefined {
  if (exactWakeIndex === -1) return undefined;
  const release = findRelease(events, exactWakeIndex, wake.holderCatId);
  if (!release) return undefined;
  const exactWakeEvidence =
    wake.protocol === 'dispatch'
      ? wake.handoff.sourceEventId
      : wake.protocol === 'hold'
        ? handedEventSourceId(wake.sourceMessageId, wake.holderCatId)
        : undefined;
  return {
    state: 'covered_empty',
    evidenceRefs: [
      `${wake.protocol}:${wake.subjectKey}`,
      ...(exactWakeEvidence ? [exactWakeEvidence] : []),
      `released:${release.sourceEventId}`,
    ],
  };
}
