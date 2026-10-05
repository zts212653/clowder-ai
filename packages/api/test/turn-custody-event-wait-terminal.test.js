/**
 * F167 — a terminal event-wait outcome is self-settling.
 *
 * `openStructured()` used to return covered_active for EVERY event_wait wake, so the
 * stop gate demanded a fresh structured transition (re-hold / handoff / new wait) even
 * when the wake only reported that its wait had already ended (PR closed, deadline hit).
 * There is nothing left to continue on a closed subject, so the gate could never be
 * satisfied legitimately.
 *
 * The carrier only holds `outcomeId = wait:<subjectRef>:g<generation>:<reason>`. Every
 * carrier here is built through the REAL producer (see the fixture), so a drift in the
 * outcomeId format fails these tests instead of silently turning the verdict off.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { waitTerminationReasonSchema } from '@cat-cafe/shared';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { turnCustodyProjectionReason } from '../dist/infrastructure/telemetry/turn-custody-shadow-telemetry.js';
import { realWaitWake, wakeWithOutcomeId } from './helpers/event-wait-terminal-fixture.js';

const HOLDER = 'codex-sol';
const ids = { holderCatId: HOLDER, subjectKey: 'ball:thread:thread-event-wait' };

const wakeFor = (reason, subjectRef) => realWaitWake(reason, { ...ids, ...(subjectRef ? { subjectRef } : {}) });

function harness({ events = [], projection = { state: 'active', holder: HOLDER } } = {}) {
  const log = [...events];
  const service = new TurnCustodyProjectionService({
    ballCustodyProjectionStore: { get: async () => projection },
    ballCustodyEventLog: { read: async (_subjectKey, fromSequence = 0) => log.slice(fromSequence) },
  });
  return { service, addEvent: (event) => log.push(event) };
}

describe('F167 terminal event-wait disposition', () => {
  for (const reason of ['subject_terminal', 'expired']) {
    test(`${reason} wake is covered_empty and never blocks the stop gate`, async () => {
      const { service } = harness();
      const opened = await service.open(wakeFor(reason));

      assert.equal(opened.state, 'covered_empty');
      const decision = await service.close(opened);
      assert.equal(decision.state, 'covered_empty');
      assert.equal(decision.shouldBlock, false);
      assert.equal(decision.transitionObserved, false);
    });
  }

  test('the verdict comes from the carrier alone, so a custody-store failure cannot revive the block', async () => {
    const services = [
      new TurnCustodyProjectionService({}),
      new TurnCustodyProjectionService({
        ballCustodyProjectionStore: { get: async () => Promise.reject(new Error('redis unavailable')) },
        ballCustodyEventLog: { read: async () => Promise.reject(new Error('redis unavailable')) },
      }),
    ];
    for (const service of services) {
      const opened = await service.open(wakeFor('subject_terminal'));
      assert.equal(opened.state, 'covered_empty');
      assert.equal((await service.close(opened)).shouldBlock, false);
    }
  });

  test('a terminal wake stays settled even when the ball has since moved to another holder', async () => {
    const { service } = harness({ projection: { state: 'active', holder: 'someone-else' } });
    const opened = await service.open(wakeFor('subject_terminal'));
    assert.equal(opened.state, 'covered_empty');
  });

  test('matched still owes a continuation: blocks until the holder re-holds or hands off', async () => {
    const { service, addEvent } = harness();
    const opened = await service.open(wakeFor('matched'));
    assert.equal(opened.state, 'covered_active');

    const unresolved = await service.close(opened);
    assert.equal(unresolved.shouldBlock, true);
    assert.equal(unresolved.transitionObserved, false);

    addEvent({ kind: 'ball.held', sourceEventId: 'held-1', payload: { catId: HOLDER } });
    const resolved = await service.close(opened);
    assert.equal(resolved.shouldBlock, false);
    assert.equal(resolved.transitionObserved, true);
    assert.equal(resolved.structuredTransitionKind, 'held');
  });

  test('only the two delivered terminals widen: every other recognised reason keeps its obligation', async () => {
    // user_cancel / owner_changed / superseded are `delivery=not_applicable` in every outcome
    // producer, so no wake normally carries them. If one ever does, behave exactly as before.
    const { service } = harness();
    for (const reason of ['user_cancel', 'owner_changed', 'superseded']) {
      const opened = await service.open(wakeFor(reason));
      assert.equal(opened.state, 'covered_active', `${reason} must not be admitted as self-settling`);
      assert.equal((await service.close(opened)).shouldBlock, true);
    }
  });

  test('every wait termination reason has a deliberate verdict, so a new reason cannot default silently', async () => {
    const verdicts = {
      matched: 'covered_active',
      subject_terminal: 'covered_empty',
      expired: 'covered_empty',
      user_cancel: 'covered_active',
      owner_changed: 'covered_active',
      superseded: 'covered_active',
    };
    const { service } = harness();
    for (const reason of waitTerminationReasonSchema.options) {
      assert.ok(reason in verdicts, `new WaitTerminationReason "${reason}" needs an explicit self-settling decision`);
      assert.equal((await service.open(wakeFor(reason))).state, verdicts[reason], reason);
    }
    assert.deepEqual(Object.keys(verdicts).sort(), [...waitTerminationReasonSchema.options].sort());
  });

  test('subjectRefs containing colons parse by their tail, not by splitting', async () => {
    const { service } = harness();
    for (const subjectRef of ['subject:task:0001790865465409-003225-f7ace56f', 'deployment:alpha:web:g1', 'a:b:c:d']) {
      const terminal = await service.open(wakeFor('subject_terminal', subjectRef));
      assert.equal(terminal.state, 'covered_empty', `${subjectRef} subject_terminal`);
      const matched = await service.open(wakeFor('matched', subjectRef));
      assert.equal(matched.state, 'covered_active', `${subjectRef} matched`);
    }
  });

  test('a subjectRef that imitates a terminal suffix cannot launder a matched wake', async () => {
    const { service } = harness();
    // Real reason is `matched`; the lookalike `:g1:subject_terminal` lives inside the subjectRef.
    const forged = await service.open(wakeFor('matched', 'subject:x:g1:subject_terminal'));
    assert.equal(forged.state, 'covered_active');
    assert.equal((await service.close(forged)).shouldBlock, true);
  });

  test('a malformed or unrecognised outcome fails closed instead of guessing', async () => {
    const { service } = harness();
    const cases = [
      'garbage',
      'wait:pr:zts212653/cat-cafe#3300:g4:totally_new_reason',
      'wait:pr:zts212653/cat-cafe#3300:g4:',
      'wait:pr:zts212653/cat-cafe#3300:gX:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:g0:subject_terminal',
      'xwait:pr:zts212653/cat-cafe#3300:g4:subject_terminal',
      ' wait:pr:zts212653/cat-cafe#3300:g4:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:g4:subject_terminal\n',
      'wait::g4:subject_terminal',
    ];
    for (const outcomeId of cases) {
      const opened = await service.open(wakeWithOutcomeId(outcomeId, ids));
      assert.equal(opened.state, 'unknown_legacy', JSON.stringify(outcomeId));
      assert.deepEqual(opened.evidenceRefs, ['unknown:event_wait_outcome_unrecognized']);
      // Bounded metric vocabulary: an unreadable carrier must surface as its own reason, not as `other`.
      assert.equal(turnCustodyProjectionReason(opened.evidenceRefs), 'event_wait_outcome_unrecognized');
      assert.equal((await service.close(opened)).shouldBlock, true, JSON.stringify(outcomeId));
    }
  });
});
