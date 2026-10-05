/**
 * F167 — a managed-hold wake is superseded only by an ACCEPTED custody transition.
 *
 * `classifyManagedHoldWake` used to treat the mere presence of a custody event as supersession. The
 * state machine rejects many of those events (a hold from `blocked`, a hold from `dead`), and some it
 * accepts change nothing (an FYI hand-off to the operator). A wake wrongly judged superseded writes a
 * subject-inert terminal while the ball leaks; a wake wrongly judged live meets a holder check that
 * can never pass (the 409 `holder_mismatch` loop). The verdict now comes from replaying the fenced
 * event snapshot through the SAME reducer the projector uses, so it can neither trust a lagging
 * materialised projection nor drift from the state machine.
 *
 * Sources: Astra's pure probes (pure-probe, supersession-family-probe, stale-projection-probe) in
 * ~/.cat-cafe/evidence/f167-3674-owner-audit/. All three are `realCaseConfirmed: false`: they prove the
 * predicate's contract, not the production root cause of wake 3674.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildHandedCvoEvent,
  buildHandedEvent,
  buildHeldEvent,
  buildHoldExpiredEvent,
  buildInvocationHeartbeatEvent,
  buildTaskBlockedEvent,
  buildWakeConditionMetEvent,
  handedEventSourceId,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import { DEAD_BALL_ZOMBIE_GRACE_MS } from '../dist/domains/ball-custody/ball-custody-state-machine.js';
import {
  classifyManagedHoldWake,
  supersededBeforeAdoption,
} from '../dist/domains/ball-custody/managed-hold-supersession.js';
import { randomEventSequences } from './helpers/ball-custody-random-events.js';

const THREAD = 'thread-1';
const SUBJECT = `ball:thread:${THREAD}`;
const HOLDER = 'cat-a';
const OTHER = 'cat-b';
const WAKE = { catId: HOLDER, sourceMessageId: 'message-wake', taskId: 'task-1' };

function timeline() {
  let clock = 1_000_000;
  const tick = (ms = 1000) => {
    clock += ms;
    return clock;
  };
  return {
    now: () => clock,
    held: (catId, fireAt) => buildHeldEvent({ threadId: THREAD, catId, fireAt: fireAt ?? clock + 600_000, at: tick() }),
    holdExpired: (catId, fireAt) => buildHoldExpiredEvent({ threadId: THREAD, catId, fireAt, at: tick() }),
    wake: (catId = HOLDER) =>
      buildWakeConditionMetEvent({
        threadId: THREAD,
        catId,
        taskId: WAKE.taskId,
        command: 'sleep 1',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        at: tick(),
      }),
    ownReceiverHandoff: () =>
      buildHandedEvent({ threadId: THREAD, toCatId: HOLDER, messageId: WAKE.sourceMessageId, at: tick() }),
    handed: (fromCatId, toCatId, messageId) =>
      buildHandedEvent({ threadId: THREAD, fromCatId, toCatId, messageId, at: tick() }),
    cvo: (fromCatId, intent) =>
      buildHandedCvoEvent({ threadId: THREAD, fromCatId, intent, messageId: `cvo-${intent}`, at: tick() }),
    // The managed-hold subject is the thread; the builder defaults a task subject.
    blocked: () => ({
      ...buildTaskBlockedEvent({ taskId: WAKE.taskId, threadId: THREAD, blockedSinceAt: tick() }),
      subjectKey: SUBJECT,
    }),
    heartbeat: (at) => buildInvocationHeartbeatEvent({ invocationId: 'inv-1', threadId: THREAD, draftUpdatedAt: at }),
    tick,
  };
}

/** A hold by HOLDER, its wake, and the wake's own receiver hand-off: HOLDER active, the wake live. */
function liveWake(t) {
  return [t.held(HOLDER), t.wake(), t.ownReceiverHandoff()];
}

const kindOf = (events, wake = WAKE, boundary) => classifyManagedHoldWake(events, wake, boundary).kind;

describe('F167 managed-hold supersession needs an accepted custody transition', () => {
  test('1. an accepted hold by another cat supersedes the wake', () => {
    const t = timeline();
    const base = liveWake(t);
    const foreignHold = t.held(OTHER);
    const result = classifyManagedHoldWake([...base, foreignHold], WAKE);
    assert.deepEqual(result, { kind: 'superseded', bySourceEventId: foreignHold.sourceEventId });
  });

  test('2. a hold the state machine REJECTS (from blocked) does not supersede, whoever issued it', () => {
    const t = timeline();
    const base = liveWake(t);
    assert.equal(kindOf([...base, t.blocked(), t.held(OTHER)]), 'live');
  });

  test('3. a rejected hold by the wake cat itself does not supersede its own wake', () => {
    const t = timeline();
    const base = liveWake(t);
    assert.equal(kindOf([...base, t.blocked(), t.held(HOLDER)]), 'live');
  });

  test('3b. an accepted re-hold by the wake cat still supersedes (the existing, correct behaviour)', () => {
    const t = timeline();
    const base = liveWake(t);
    assert.equal(kindOf([...base, t.held(HOLDER)]), 'superseded');
  });

  test('4. an FYI hand-off to the operator changes no custody and does not supersede', () => {
    const t = timeline();
    const base = liveWake(t);
    assert.equal(kindOf([...base, t.cvo(HOLDER, 'fyi')]), 'live');
  });

  test('4b. a operator hand-off that really moves the ball (handoff, done_notify) still supersedes; a bad intent does not', () => {
    for (const [intent, expected] of [
      ['handoff', 'superseded'],
      ['done_notify', 'superseded'],
      ['bogus', 'live'],
    ]) {
      const t = timeline();
      assert.equal(kindOf([...liveWake(t), t.cvo(HOLDER, intent)]), expected, intent);
    }
  });

  test('4c. an accepted hand-off away from, or to another cat involving, the wake cat supersedes', () => {
    const away = timeline();
    assert.equal(kindOf([...liveWake(away), away.handed(HOLDER, OTHER, 'm-away')]), 'superseded');
    const toward = timeline();
    assert.equal(kindOf([...liveWake(toward), toward.handed(OTHER, HOLDER, 'm-toward')]), 'superseded');
  });

  test('5. the wake’s own receiver hand-off is its delivery, never its replacement', () => {
    const t = timeline();
    assert.equal(kindOf(liveWake(t)), 'live');
    assert.equal(
      handedEventSourceId(WAKE.sourceMessageId, HOLDER),
      liveWake(timeline())[2].sourceEventId,
      'the fixture really is the exact receiver hand-off',
    );
  });

  test('6. the adoption boundary: a continuation after adoption is not supersession; the same event before it is', () => {
    const t = timeline();
    const base = liveWake(t);
    const events = [...base, t.held(OTHER)];
    assert.equal(kindOf(events, WAKE, base.length), 'live', 'post-adoption hold is a continuation witness');
    assert.equal(kindOf(events, WAKE, events.length), 'superseded', 'pre-adoption hold superseded the wake');
    assert.equal(supersededBeforeAdoption(events, WAKE, SUBJECT)?.[0], `hold:${SUBJECT}`);
    assert.equal(supersededBeforeAdoption(base, WAKE, SUBJECT), undefined);
  });

  describe('7. acceptance follows the real state machine, not just who holds the ball', () => {
    test('7a. a hold_expired that matches the hold kills the ball, so a later foreign hold is rejected', () => {
      const t = timeline();
      const fireAt = t.now() + 5000;
      // No receiver hand-off yet: that hand-off clears heldUntil, and this is about heldUntil.
      const events = [t.held(HOLDER, fireAt), t.wake(), t.holdExpired(HOLDER, fireAt), t.held(OTHER)];
      // Hold expiry made the ball `dead`; a hold is only accepted from new/active/resolved.
      assert.equal(kindOf(events), 'live');
    });

    test('7b. a hold_expired for an older fireAt is rejected, the ball stays active, a later foreign hold supersedes', () => {
      const t = timeline();
      const fireAt = t.now() + 5000;
      const events = [t.held(HOLDER, fireAt), t.wake(), t.holdExpired(HOLDER, fireAt - 1), t.held(OTHER)];
      assert.equal(kindOf(events), 'superseded');
    });

    test('7c. the dead-ball heartbeat grace: inside it the ball revives, outside it stays dead', () => {
      for (const [offset, expected] of [
        [DEAD_BALL_ZOMBIE_GRACE_MS, 'superseded'],
        [DEAD_BALL_ZOMBIE_GRACE_MS + 1, 'live'],
      ]) {
        const t = timeline();
        const fireAt = t.now() + 5000;
        const base = [t.held(HOLDER, fireAt), t.wake()];
        const expired = t.holdExpired(HOLDER, fireAt);
        const events = [...base, expired, t.heartbeat(expired.at + offset)];
        events.push({ ...t.held(OTHER), at: expired.at + offset + 1000 });
        assert.equal(kindOf(events), expected, `heartbeat ${offset}ms after death`);
      }
    });
  });

  test('8. truncating the log at any boundary never changes the verdict for that boundary', () => {
    let checked = 0;
    for (const events of randomEventSequences(400, 20001)) {
      const wakeIndex = events.findIndex((event) => event.kind === 'ball.wake_condition_met');
      if (wakeIndex === -1) continue;
      const wake = { catId: events[wakeIndex].payload.catId, sourceMessageId: 'message-wake', taskId: 'task-1' };
      for (let boundary = wakeIndex + 1; boundary <= events.length; boundary += 1) {
        assert.deepEqual(
          classifyManagedHoldWake(events, wake, boundary),
          classifyManagedHoldWake(events.slice(0, boundary), wake),
          `boundary ${boundary} of ${events.length} (${events[0].sourceEventId})`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > 1000, `only ${checked} boundaries were exercised`);
  });

  test('a wake that never happened stays wake_missing, and an empty tail stays live', () => {
    const t = timeline();
    assert.equal(kindOf([t.held(HOLDER)]), 'wake_missing');
    assert.equal(kindOf([t.held(HOLDER), t.wake()]), 'live');
  });
});
