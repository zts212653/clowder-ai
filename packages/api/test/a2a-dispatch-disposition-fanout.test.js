/**
 * F167 — fan-out A2A dispatch must not demand a single-holder disposition.
 *
 * Regression for thread_mrqb0yfauece1tmm (2026-08-19 七神调测 v2): a fan-out
 * mention (one trigger message, 8 line-start @targets) emits one handed event
 * per target — all sharing `route:{messageId}:{toCatId}`. The ball projection
 * tracks a single holder (the last handed target), so every other target hit
 * `unknown('structured_holder_mismatch')` at open, and even the last target
 * waited for a `ball.dispatch_dispositioned` that only a successful
 * `complete_a2a_dispatch` (409 for non-holders) could ever write. The F167
 * Phase T stop-gate then flipped successful turns into
 * `a2a_dispatch_disposition_missing` failures, which rolled queue entries back
 * to queued/failed and permanently blocked the queue head.
 *
 * Semantics: sibling handed events for the same trigger message mean the ball
 * was broadcast, not transferred. Fan-out delivery is a non-obligation for the
 * turn-custody gate; the anti-dropout guarantee for fan-out lives in queue
 * entry settlement (F122B aggregate success), not in the single-ball model.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
  createA2ADispositionWake as dispatchWake,
} from './helpers/a2a-dispatch-disposition-harness.js';

async function gate(h) {
  return new TurnCustodyProjectionService({
    ballCustodyProjectionStore: h.projectionStore,
    ballCustodyEventLog: h.eventLog,
  });
}

describe('F167 fan-out A2A dispatch (same message, multiple handed targets)', () => {
  test('non-final target is not blocked when a sibling handed event exists for the same message', async () => {
    const h = await harness();
    // Fan-out: the same trigger message is also handed to a second target.
    // The projection holder becomes the LAST handed target ('other-cat').
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'other-cat',
        messageId: h.source.id,
        at: 1_100,
      }),
    );

    const opened = await (await gate(h)).open(dispatchWake(h));
    const decision = await (await gate(h)).close(opened);

    assert.equal(decision.shouldBlock, false);
    assert.equal(decision.state, 'covered_empty');
  });

  test('final target (projection holder) is not blocked by a missing disposition under fan-out', async () => {
    const h = await harness();
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'codex-sol',
        messageId: h.source.id,
        at: 1_000,
      }),
    );
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'other-cat',
        messageId: h.source.id,
        at: 1_100,
      }),
    );

    const wake = {
      ...dispatchWake(h),
      holderCatId: 'other-cat',
      handoff: { ...dispatchWake(h).handoff, sourceEventId: `route:${h.source.id}:other-cat` },
    };
    const opened = await (await gate(h)).open(wake);
    const decision = await (await gate(h)).close(opened);

    assert.equal(decision.shouldBlock, false);
  });

  test('single-target dispatch still demands its exact disposition (no regression)', async () => {
    const h = await harness();
    const service = await gate(h);

    const opened = await service.open(dispatchWake(h));
    assert.equal((await service.close(opened)).shouldBlock, true);

    await h.service.complete(auth(h), 'completed');
    const settled = await service.close(opened);
    assert.equal(settled.shouldBlock, false);
    assert.equal(settled.structuredTransitionKind, 'dispatch_dispositioned');
  });
});
