/**
 * Retire or settle: the one decision a managed-hold wake needs before it can reach a terminal.
 *
 * A wake is a timed notification, not custody of the ball. When it fires the wake cat holds the ball
 * (`wake_condition_met` is only accepted from `active`). It can be settled normally (the disposition
 * advances the subject) only while that is still true. Once the wake cat no longer holds the ball,
 * nothing is left for the settlement to advance, so the wake reaches a retired terminal instead: it
 * is inert on the subject plane and still lets the stop gate and the Queue receipt close. Refusing it
 * (the old holder assertion) answered 409 `holder_mismatch` forever while Queue re-injected the wake.
 *
 * One invariant replaces a patch per state: a settlement is attempted only when the state machine
 * would accept it. The verdict is replayed from the fenced event snapshot through the same reducer the
 * projector uses, so it is exactly the complement of what `resolveDisposition` rejects and can neither
 * trail the log (as the projection store can) nor drift from the state machine.
 *
 * Pure: no IO, no clock.
 */

import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { ManagedHoldRetiredReason } from './ball-custody-events.js';
import { replayBallCustodyProjection } from './ball-custody-projection-reducer.js';
import { classifyManagedHoldWake, type ManagedHoldWakeIdentity } from './managed-hold-supersession.js';

export type ManagedHoldRetirement =
  | { readonly kind: 'wake_missing' }
  /** The wake cat still holds the ball (`active` or `blocked`): settle normally. */
  | { readonly kind: 'live' }
  | { readonly kind: 'retired'; readonly reason: ManagedHoldRetiredReason };

/**
 * `superseded` is the early, specific classification (custody moved to someone else) and wins when
 * both are true. Otherwise `subject_resolved` (the subject itself ended) is more specific than
 * `ball_not_held` (anything else that leaves the wake cat without the ball: void, parked, zombie,
 * dead, or another holder). The state behind `ball_not_held` stays readable from the projection.
 */
export function classifyManagedHoldRetirement(
  events: readonly BallCustodyEvent[],
  wake: ManagedHoldWakeIdentity,
): ManagedHoldRetirement {
  const supersession = classifyManagedHoldWake(events, wake);
  if (supersession.kind === 'wake_missing') return { kind: 'wake_missing' };
  if (supersession.kind === 'superseded') return { kind: 'retired', reason: 'superseded' };

  const projection = replayBallCustodyProjection(events);
  if (projection?.state === 'resolved') return { kind: 'retired', reason: 'subject_resolved' };
  const holdsBall =
    (projection?.state === 'active' || projection?.state === 'blocked') && projection.holder === wake.catId;
  return holdsBall ? { kind: 'live' } : { kind: 'retired', reason: 'ball_not_held' };
}
