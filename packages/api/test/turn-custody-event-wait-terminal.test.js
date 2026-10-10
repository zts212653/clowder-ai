/**
 * F167 / ADR-043 — event-wait wakes are ordinary lifecycle delivery.
 *
 * The independent stop gate is retired for every event-wait outcome. The exact
 * carrier is validated at Queue admission; the resulting response owns execution
 * and continuation. Opaque outcome IDs must not manufacture another obligation.
 *
 * The carrier only holds `outcomeId = wait:<subjectRef>:g<generation>:<reason>`. Every
 * carrier here is built through the REAL producer (see the fixture), so a drift in the
 * outcomeId format fails these tests instead of silently turning the verdict off.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { waitTerminationReasonSchema } from '@cat-cafe/shared';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { realWaitOutcome, realWaitWake, wakeWithOutcomeId } from './helpers/event-wait-terminal-fixture.js';

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

  test('matched continuation is lifecycle-owned and needs no second Ball transition', async () => {
    const { service, addEvent } = harness();
    const opened = await service.open(wakeFor('matched'));
    assert.equal(opened.state, 'covered_empty');
    assert.deepEqual(opened.evidenceRefs, ['lifecycle:event_wait']);

    const unresolved = await service.close(opened);
    assert.equal(unresolved.shouldBlock, false);
    assert.equal(unresolved.transitionObserved, false);

    addEvent({ kind: 'ball.held', sourceEventId: 'held-1', payload: { catId: HOLDER } });
    const resolved = await service.close(opened);
    assert.equal(resolved.shouldBlock, false);
    assert.equal(resolved.transitionObserved, false, 'a Ball event is not this response delivery evidence');
  });

  test('non-delivering wait outcomes never acquire a second execution obligation', async () => {
    // user_cancel / owner_changed / superseded are `delivery=not_applicable` in every outcome
    // producer, so no wake normally carries them. An opaque carrier cannot change that fact.
    const { service } = harness();
    for (const reason of ['user_cancel', 'owner_changed', 'superseded']) {
      const opened = await service.open(wakeFor(reason));
      assert.equal(opened.state, 'covered_empty', reason);
      assert.equal((await service.close(opened)).shouldBlock, false);
    }
  });

  test('every wait termination reason has a deliberate verdict, so a new reason cannot default silently', async () => {
    const verdicts = {
      matched: 'covered_empty',
      subject_terminal: 'covered_empty',
      expired: 'covered_empty',
      user_cancel: 'covered_empty',
      owner_changed: 'covered_empty',
      superseded: 'covered_empty',
    };
    const { service } = harness();
    for (const reason of waitTerminationReasonSchema.options) {
      assert.ok(reason in verdicts, `new WaitTerminationReason "${reason}" needs an explicit self-settling decision`);
      assert.equal(
        realWaitOutcome(reason).delivery,
        ['matched', 'subject_terminal', 'expired'].includes(reason) ? 'pending' : 'not_applicable',
        `${reason} must retain its actual producer delivery boundary`,
      );
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
      assert.equal(matched.state, 'covered_empty', `${subjectRef} matched`);
    }
  });

  test('a subjectRef that imitates a terminal suffix cannot launder a matched wake', async () => {
    const { service } = harness();
    // Real reason is `matched`; the lookalike `:g1:subject_terminal` lives inside the subjectRef.
    const forged = await service.open(wakeFor('matched', 'subject:x:g1:subject_terminal'));
    assert.equal(forged.state, 'covered_empty');
    assert.deepEqual(forged.evidenceRefs, ['lifecycle:event_wait']);
    assert.equal((await service.close(forged)).shouldBlock, false);
  });

  test('unrecognised outcome text cannot create a Ball obligation or serve as terminal evidence', async () => {
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
      assert.equal(opened.state, 'covered_empty', JSON.stringify(outcomeId));
      assert.deepEqual(opened.evidenceRefs, ['lifecycle:event_wait']);
      assert.equal((await service.close(opened)).transitionObserved, false);
      assert.equal((await service.close(opened)).shouldBlock, false, JSON.stringify(outcomeId));
    }
  });
});
