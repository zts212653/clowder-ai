/**
 * F167 — a managed-hold wake is settled only when the state machine would accept the settlement.
 *
 * `classifyManagedHoldRetirement` is the single retire-or-settle decision. Its correctness is not a list of
 * states: it is an equivalence with the state machine. Whenever the verdict is `live`, a normal settlement
 * of that wake is ACCEPTED by the reducer; whenever it is `subject_resolved` or `ball_not_held`, a normal
 * settlement would be REJECTED. So the old failure (settle, be refused, answer 409 holder_mismatch forever)
 * cannot happen for any log, including logs no hand-written case thought of.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildHandedEvent,
  buildHeldEvent,
  buildHoldDispositionEvent,
  buildTaskDoneEvent,
  buildWakeConditionMetEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  reduceBallCustodyEvent,
  replayBallCustodyProjection,
} from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { classifyManagedHoldRetirement } from '../dist/domains/ball-custody/managed-hold-retirement.js';
import { randomEventSequences } from './helpers/ball-custody-random-events.js';

const SOURCE = 'message-wake';
const TASK = 'task-1';
const THREAD = 'thread-1';
const SUBJECT = `ball:thread:${THREAD}`;

const wakeOf = (catId) => ({ catId, sourceMessageId: SOURCE, taskId: TASK });

/** Would the state machine accept a NORMAL (non-retired) settlement of this wake at the end of `events`? */
function settlementAccepted(events, catId) {
  const last = events.at(-1);
  const settlement = buildHoldDispositionEvent({
    threadId: THREAD,
    catId,
    invocationId: 'inv-probe',
    sourceMessageId: SOURCE,
    taskId: TASK,
    disposition: 'completed',
    at: last.at + 1,
  });
  return reduceBallCustodyEvent(replayBallCustodyProjection(events), settlement).accepted;
}

describe('F167 managed-hold retirement is the complement of what the state machine rejects', () => {
  /**
   * Check the equivalence for every wake in every log, at every boundary after the wake. Returns how often
   * each verdict was seen, so a caller can prove the generator really reached both sides of the equivalence.
   */
  function checkEquivalence(logs, firstSeed) {
    const seen = { live: 0, superseded: 0, subject_resolved: 0, ball_not_held: 0 };
    for (const [index, events] of logs.entries()) {
      events.forEach((event, wakeIndex) => {
        if (event.kind !== 'ball.wake_condition_met') return;
        const catId = event.payload.catId;
        for (let boundary = wakeIndex + 1; boundary <= events.length; boundary += 1) {
          const prefix = events.slice(0, boundary);
          const verdict = classifyManagedHoldRetirement(prefix, wakeOf(catId));
          const where = `log ${firstSeed + index}, wake at ${wakeIndex}, boundary ${boundary}`;
          assert.notEqual(verdict.kind, 'wake_missing', where);
          if (verdict.kind === 'live') {
            seen.live += 1;
            assert.equal(
              settlementAccepted(prefix, catId),
              true,
              `live but the state machine would refuse it: ${where}`,
            );
          } else if (verdict.reason === 'superseded') {
            // Retired early for a specific reason; no constraint on whether a settlement would also be accepted
            // (a re-hold by the same cat is superseded while that cat still holds the ball).
            seen.superseded += 1;
          } else {
            seen[verdict.reason] += 1;
            assert.equal(
              settlementAccepted(prefix, catId),
              false,
              `${verdict.reason} but the state machine would accept it: ${where}`,
            );
          }
        }
      });
    }
    return seen;
  }

  const wakeFor = (catId, at) =>
    buildWakeConditionMetEvent({
      threadId: THREAD,
      catId,
      taskId: TASK,
      command: 'sleep 1',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      at,
    });

  test('over random logs: live <=> a normal settlement is accepted; the two non-supersession reasons <=> it is rejected', () => {
    const seen = checkEquivalence(randomEventSequences(500, 31001), 31001);
    for (const kind of ['superseded', 'subject_resolved', 'ball_not_held']) {
      assert.ok(seen[kind] > 100, `the generator barely exercises ${kind}: ${seen[kind]}`);
    }
  });

  test('over logs that fire a wake for a cat that holds the ball, then anything: both sides of the equivalence are reached', () => {
    // A random log rarely leaves the wake cat holding the ball, so build it: hold, wake, then a random tail.
    const logs = randomEventSequences(500, 41001).map((tail, index) => {
      const catId = ['cat-a', 'cat-b', 'cat-c'][index % 3];
      return [buildHeldEvent({ threadId: THREAD, catId, fireAt: 99_000, at: 1_000 }), wakeFor(catId, 2_000), ...tail];
    });
    const seen = checkEquivalence(logs, 41001);
    for (const [kind, count] of Object.entries(seen)) {
      assert.ok(count > 100, `the generator barely exercises ${kind}: ${count}`);
    }
  });

  test('superseded wins over subject_resolved when both are true at the end of the log', () => {
    const events = [
      buildHeldEvent({ threadId: THREAD, catId: 'cat-a', fireAt: 99_000, at: 1_000 }),
      buildWakeConditionMetEvent({
        threadId: THREAD,
        catId: 'cat-a',
        taskId: TASK,
        command: 'sleep 1',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        at: 2_000,
      }),
      buildHeldEvent({ threadId: THREAD, catId: 'cat-b', fireAt: 99_000, at: 2_500 }),
      { ...buildTaskDoneEvent({ taskId: TASK, at: 2_600 }), subjectKey: SUBJECT },
    ];
    assert.equal(replayBallCustodyProjection(events).state, 'resolved');
    assert.deepEqual(classifyManagedHoldRetirement(events, wakeOf('cat-a')), { kind: 'retired', reason: 'superseded' });
  });

  test('a third cat taking the ball is ball_not_held, not superseded: the wake cat is named by neither side', () => {
    const events = [
      buildHeldEvent({ threadId: THREAD, catId: 'cat-a', fireAt: 99_000, at: 1_000 }),
      buildWakeConditionMetEvent({
        threadId: THREAD,
        catId: 'cat-a',
        taskId: TASK,
        command: 'sleep 1',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        at: 2_000,
      }),
      buildHandedEvent({ threadId: THREAD, fromCatId: 'cat-c', toCatId: 'cat-b', messageId: 'm-third', at: 2_500 }),
    ];
    assert.deepEqual(classifyManagedHoldRetirement(events, wakeOf('cat-a')), {
      kind: 'retired',
      reason: 'ball_not_held',
    });
  });

  test('a wake that never fired is wake_missing, not retired', () => {
    const events = [buildHeldEvent({ threadId: THREAD, catId: 'cat-a', fireAt: 99_000, at: 1_000 })];
    assert.deepEqual(classifyManagedHoldRetirement(events, wakeOf('cat-a')), { kind: 'wake_missing' });
  });
});
