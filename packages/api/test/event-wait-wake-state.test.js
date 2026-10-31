/**
 * F167 — the shared per-wake facts of the event-wait protocol (producer and stop-gate consumer read the same ones).
 *
 * `classifyEventWaitWake` decides, from ONE log snapshot, whether completing a wake advances the thread subject (live)
 * or only closes its own obligation (retired). Review of #5049: it must recognise a LATER ACCEPTED custody source as
 * supersession, and must not mistake a rejected event or an FYI that moved nothing for one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildHandedEvent, buildHeldEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { buildWaitDispositionEvent } from '../dist/domains/ball-custody/event-wait-events.js';
import {
  classifyEventWaitWake,
  eventWaitReceiverHandoffIndex,
  findEventWaitTerminal,
} from '../dist/domains/ball-custody/event-wait-wake-state.js';

const THREAD = 'thread-wake-state';
const CAT = 'codex-astra';
const WAKE = 'wake-1';

const handedToCat = (at = 1_000, messageId = WAKE) =>
  buildHandedEvent({ threadId: THREAD, toCatId: CAT, messageId, at });
const classify = (events) =>
  classifyEventWaitWake(events, {
    catId: CAT,
    receiverHandoffIndex: eventWaitReceiverHandoffIndex(events, WAKE, CAT),
    wakeMessageId: WAKE,
  });
const event = (kind, payload, sourceEventId, classification = 'state-changing') => ({
  kind,
  sourceEventId,
  subjectKey: `ball:thread:${THREAD}`,
  classification,
  payload,
  at: 2_000,
});

describe('F167 event-wait wake state', () => {
  test('the cat that was handed the ball and has done nothing else holds a live wake', () => {
    assert.deepEqual(classify([handedToCat()]), { kind: 'live' });
    assert.deepEqual(
      classify([handedToCat(), event('invocation.started', { catId: CAT, invocationId: 'i' }, 'inv:i:started')]),
      { kind: 'live' },
      'its own invocation starting is not a replacement',
    );
  });

  test('a later ACCEPTED custody source replaces the wake: a re-hold, a hand-off away, a new hand-off to the cat', () => {
    const rehold = [handedToCat(), buildHeldEvent({ threadId: THREAD, catId: CAT, fireAt: 99_000, at: 2_000 })];
    assert.deepEqual(classify(rehold), { kind: 'retired', reason: 'superseded' });

    const heldByAnother = [
      handedToCat(),
      buildHeldEvent({ threadId: THREAD, catId: 'opus55', fireAt: 99_000, at: 2_000 }),
    ];
    assert.deepEqual(classify(heldByAnother), { kind: 'retired', reason: 'superseded' });

    const handedAway = [
      handedToCat(),
      buildHandedEvent({ threadId: THREAD, fromCatId: CAT, toCatId: 'opus55', messageId: 'm2', at: 2_000 }),
    ];
    assert.deepEqual(classify(handedAway), { kind: 'retired', reason: 'superseded' });

    const secondWake = [handedToCat(), handedToCat(2_000, 'wake-2')];
    assert.deepEqual(classify(secondWake), { kind: 'retired', reason: 'superseded' });
  });

  test('a rejected event, and an FYI that moved nothing, did not take the ball', () => {
    // From `blocked` the state machine rejects ball.held (only new / active / resolved accept it).
    const blocked = [
      handedToCat(),
      event('task.blocked', { taskId: 't1' }, 'task:t1:blocked:1'),
      buildHeldEvent({ threadId: THREAD, catId: 'opus55', fireAt: 99_000, at: 2_100 }),
    ];
    assert.deepEqual(classify(blocked), { kind: 'live' }, 'a rejected re-hold superseded nothing');

    const fyi = [handedToCat(), event('ball.handed_cvo', { fromCatId: CAT, intent: 'fyi' }, 'cvo:fyi:1')];
    assert.deepEqual(classify(fyi), { kind: 'live' }, 'an FYI to the operator moves custody nowhere');
  });

  test('with no replacing event the reason is the more specific truth: the subject ended, or someone else holds', () => {
    const resolved = [handedToCat(), event('task.done', { taskId: 't1' }, 'task:t1:done')];
    assert.deepEqual(classify(resolved), { kind: 'retired', reason: 'subject_resolved' });

    const someoneElse = [
      handedToCat(),
      buildHandedEvent({ threadId: THREAD, fromCatId: 'x', toCatId: 'opus55', messageId: 'm3', at: 2_000 }),
    ];
    assert.deepEqual(classify(someoneElse), { kind: 'retired', reason: 'ball_not_held' });
  });

  test('the terminal is found by (cat, wait, outcome) alone: any invocation, no other cat, wait or outcome', () => {
    const terminal = buildWaitDispositionEvent({
      threadId: THREAD,
      catId: CAT,
      invocationId: 'inv-a',
      sourceMessageId: WAKE,
      waitId: 'wait-1',
      outcomeId: 'wait:deployment:x:g1:matched',
      disposition: 'completed',
      at: 3_000,
    });
    const id = { catId: CAT, waitId: 'wait-1', outcomeId: 'wait:deployment:x:g1:matched' };

    assert.equal(findEventWaitTerminal([terminal], id), terminal);
    for (const other of [{ catId: 'opus55' }, { waitId: 'wait-2' }, { outcomeId: 'wait:deployment:x:g2:matched' }]) {
      assert.equal(findEventWaitTerminal([terminal], { ...id, ...other }), undefined, JSON.stringify(other));
    }
    assert.equal(
      findEventWaitTerminal([{ ...terminal, kind: 'ball.hold_dispositioned' }], id),
      undefined,
      'only an event-wait terminal settles an event-wait wake',
    );
  });

  test('the receiver handoff is located by the exact (message, cat) pair', () => {
    const events = [handedToCat(1_000, 'other-wake'), handedToCat()];
    assert.equal(eventWaitReceiverHandoffIndex(events, WAKE, CAT), 1);
    assert.equal(eventWaitReceiverHandoffIndex(events, WAKE, 'someone-else'), -1);
    assert.equal(eventWaitReceiverHandoffIndex(events, 'never', CAT), -1);
  });
});
