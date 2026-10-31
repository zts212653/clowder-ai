import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { ManagedHoldRetiredReason } from './ball-custody-events.js';

/**
 * Event builders for the event-wait completion terminal (F167 KD-33).
 *
 * Kept out of `ball-custody-events.ts` on purpose: that file is large and is imported by browser-verification API
 * fixtures, so every edit to it fans out to ten unrelated browser journeys. These builders are only reached from the
 * custody service layer.
 */

/** The closed set of codes an event-wait completion may carry. The type derives from it, so a reader cannot drift. */
export const EVENT_WAIT_DISPOSITIONS = ['handled', 'completed'] as const;
export type EventWaitDisposition = (typeof EVENT_WAIT_DISPOSITIONS)[number];

export interface WaitDispositionEventInput {
  threadId: string;
  catId: string;
  invocationId: string;
  /** The connector message that delivered the matched wait outcome to this cat. */
  sourceMessageId: string;
  waitId: string;
  outcomeId: string;
  disposition: EventWaitDisposition;
  /** The holder no longer owned the ball: a retired completion closes only this exact obligation and stays inert. */
  retired?: boolean;
  retiredReason?: ManagedHoldRetiredReason;
  at: number;
}

/**
 * A wake's identity is (cat, wait, outcome), NOT the invocation that happened to settle it: when the queue re-exposes
 * the same wake to a successor invocation, that successor must see the terminal that already exists. `waitId` is part of
 * it because outcomes are not unique per wait: two Tasks waiting on the same deployment share an `outcomeId`.
 */
export function waitDispositionEventSourceId(input: { catId: string; waitId: string; outcomeId: string }): string {
  return `wait-disposition:${input.catId}:${input.waitId}:${input.outcomeId}`;
}

/** Exact event-wait completion; caller identity, wake message and carrier are server-derived. */
export function buildWaitDispositionEvent(input: WaitDispositionEventInput): BallCustodyEvent {
  return {
    sourceEventId: waitDispositionEventSourceId(input),
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.wait_dispositioned',
    classification: 'state-changing',
    payload: {
      catId: input.catId,
      invocationId: input.invocationId,
      sourceMessageId: input.sourceMessageId,
      waitId: input.waitId,
      outcomeId: input.outcomeId,
      disposition: input.disposition,
      ...(input.retired ? { retired: true } : {}),
      ...(input.retired && input.retiredReason ? { retiredReason: input.retiredReason } : {}),
    },
    at: input.at,
  };
}
