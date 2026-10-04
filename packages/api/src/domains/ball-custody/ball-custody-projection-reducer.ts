/**
 * Ball custody projection reducer — the ONE definition of what an event does to a projection.
 *
 * Pure: no IO, no clock (`event.at` is the clock), no store. `BallCustodyProjector.apply()` persists
 * its result; `rebuild()` replays through `apply()`; supersession replays the same fold without
 * persisting. Three consumers, one truth, so "was this event accepted?" can never mean one thing to
 * the projector and another to a predicate that reasons about the same log.
 *
 * Invariants (carried over from the projector):
 *  - a rejected transition never changes `state` (INV-5); it records `lastRejectedEvent` only for
 *    state-changing events, so informational rejects do not pollute observability;
 *  - replaying the full event log yields a field-for-field identical projection (INV-2).
 */

import type { BallCustodyEvent, BallCustodyProjection, BallIntent, BallResolveMode } from '@cat-cafe/shared';
import { transition } from './ball-custody-state-machine.js';

const VALID_INTENTS: BallIntent[] = ['handoff', 'fyi', 'done_notify'];
const VALID_RESOLVE_MODES: BallResolveMode[] = ['bounces_back', 'completes'];

export function createInitialProjection(subjectKey: string, now: number): BallCustodyProjection {
  return {
    subjectKey,
    state: 'new',
    holder: null,
    intent: null,
    resolveMode: null,
    heldUntil: null,
    blockedSinceAt: null,
    lastWakeAt: null,
    lastScanAt: null,
    lastStateChangeAt: now,
    lastEventAt: now,
    appliedEventCount: 0,
    lastRejectedEvent: null,
    createdAt: now,
    updatedAt: now,
  };
}

type FieldEffect = (proj: BallCustodyProjection, payload: BallCustodyEvent['payload'], now: number) => void;

/** accepted transition 后应用字段 effect（mutate proj）。plan §B 标注的副字段更新。 */
const FIELD_EFFECTS: Partial<Record<BallCustodyEvent['kind'], FieldEffect>> = {
  'ball.handed': (proj, p) => {
    if (typeof p.toCatId === 'string') proj.holder = p.toCatId;
  },
  'ball.handed_cvo': (proj, p) => {
    if (typeof p.intent === 'string' && VALID_INTENTS.includes(p.intent as BallIntent)) {
      proj.intent = p.intent as BallIntent;
    }
    if (proj.state === 'parked') proj.holder = 'cvo';
  },
  'ball.held': (proj, p) => {
    if (typeof p.catId === 'string') proj.holder = p.catId;
    if (typeof p.fireAt === 'number') proj.heldUntil = p.fireAt;
  },
  // 新 blocked episode：blockedSinceAt 记 episode identity，清 lastWakeAt（去重锚重置）
  'task.blocked': (proj, p, now) => {
    proj.blockedSinceAt = now;
    proj.lastWakeAt = null;
    proj.resolveMode =
      typeof p.resolveMode === 'string' && VALID_RESOLVE_MODES.includes(p.resolveMode as BallResolveMode)
        ? (p.resolveMode as BallResolveMode)
        : null;
  },
  // best-effort 唤醒已发的记录（仅 blocked 接受，见 transition）
  'ball.wake_sent': (proj, _p, now) => {
    proj.lastWakeAt = now;
  },
  'invocation.died': (proj, p, now) => {
    proj.lastScanAt = typeof p.lastScanAt === 'number' ? p.lastScanAt : now;
  },
};

function applyFieldEffects(proj: BallCustodyProjection, event: BallCustodyEvent, now: number): void {
  FIELD_EFFECTS[event.kind]?.(proj, event.payload, now);
}

/**
 * 清 stale transient state fields（cloud review P2 + failure-mode audit）。每个 transient field
 * 只属于特定 state，球离开该 state 旧值就 stale，必须清，否则后续判定误用 stale 值：
 *   - heldUntil 绑 active(held)：换 holder（ball.handed）或离开 active 清（否则 hold_expired 误判已转走的球 dead）
 *   - blockedSinceAt/lastWakeAt 绑 blocked episode：离开 blocked 清（否则跨 episode 污染唤醒去重/晾龄）
 *   - intent 绑 parked(cvo)：离开 parked 清（否则球转回猫后残留 operator intent）
 * 进入态的 setter 在 applyFieldEffects（task.blocked 设 blockedSinceAt+清 lastWakeAt、ball.held 设
 * heldUntil 等），与本函数「离开清」互补：setter 后 state 仍在归属态，不会被清。
 */
function clearStaleTransientFields(proj: BallCustodyProjection, event: BallCustodyEvent): void {
  if (event.kind === 'ball.handed' || proj.state !== 'active') {
    proj.heldUntil = null;
  }
  if (proj.state !== 'blocked') {
    proj.blockedSinceAt = null;
    proj.lastWakeAt = null;
    proj.resolveMode = null;
  }
  if (proj.state !== 'parked') {
    proj.intent = null;
  }
}

export interface BallEventReduction {
  /** Whether the state machine accepted the transition (a rejected event still updates bookkeeping). */
  readonly accepted: boolean;
  /** The projection the event was applied to (the initial one when the subject had none). */
  readonly before: BallCustodyProjection;
  /** The projection after the event. Never aliases `before`. */
  readonly after: BallCustodyProjection;
}

/**
 * Apply one event. `existing` is the projection so far (`null` = the subject's first event).
 * Never mutates `existing`.
 */
export function reduceBallCustodyEvent(
  existing: BallCustodyProjection | null,
  event: BallCustodyEvent,
): BallEventReduction {
  const now = event.at;
  const before = existing ?? createInitialProjection(event.subjectKey, now);

  const result = transition(before.state, event, {
    holder: before.holder,
    heldUntil: before.heldUntil,
    lastStateChangeAt: before.lastStateChangeAt,
  });

  if (!result.ok) {
    // rejected：不改 state。state-changing 记 lastRejectedEvent（observability）；
    // informational（ball.wake_sent 非 blocked）不记（不污染）。
    return {
      accepted: false,
      before,
      after: {
        ...before,
        lastEventAt: now,
        updatedAt: now,
        lastRejectedEvent: event.classification === 'state-changing' ? event : before.lastRejectedEvent,
      },
    };
  }

  const stateChanged = result.next !== before.state;
  const after: BallCustodyProjection = {
    ...before,
    state: result.next,
    appliedEventCount: before.appliedEventCount + 1,
    lastRejectedEvent: null,
    lastEventAt: now,
    updatedAt: now,
    lastStateChangeAt: stateChanged ? now : before.lastStateChangeAt,
  };
  applyFieldEffects(after, event, now);
  clearStaleTransientFields(after, event);
  return { accepted: true, before, after };
}

/**
 * The projection a full replay of `events` ends in (`null` for an empty log). Unlike the materialised
 * projection store, this can never trail the log it is read together with: a decision that is fenced on
 * `events.length` (an append-fenced write) must be derived from exactly this snapshot, not from a cache
 * that ingest has not caught up with yet.
 */
export function replayBallCustodyProjection(events: readonly BallCustodyEvent[]): BallCustodyProjection | null {
  let projection: BallCustodyProjection | null = null;
  for (const event of events) projection = reduceBallCustodyEvent(projection, event).after;
  return projection;
}

/** What one replayed event did, as far as custody is concerned. */
export interface BallEventOutcome {
  readonly accepted: boolean;
  readonly stateChanged: boolean;
}

/**
 * Fold the reducer over `events[0, upTo)` without persisting anything. The outcome at index `i`
 * depends only on `events[0..i)` and `events[i]`, so truncating the log at any boundary never
 * changes the outcomes before it.
 */
export function replayBallCustodyOutcomes(
  events: readonly BallCustodyEvent[],
  upTo: number = events.length,
): BallEventOutcome[] {
  const end = Math.min(events.length, Math.max(0, upTo));
  const outcomes: BallEventOutcome[] = [];
  let projection: BallCustodyProjection | null = null;
  for (let index = 0; index < end; index += 1) {
    const reduction = reduceBallCustodyEvent(projection, events[index] as BallCustodyEvent);
    outcomes.push({ accepted: reduction.accepted, stateChanged: reduction.after.state !== reduction.before.state });
    projection = reduction.after;
  }
  return outcomes;
}
