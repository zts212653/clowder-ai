/**
 * F167 — same-cat cross-thread A2A disposition boundary.
 *
 * A catId identifies a persona, so parallel invocations require durable
 * distinct-thread provenance to distinguish a legitimate handoff from an
 * ordinary same-thread self mention.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

describe('F167 same-cat A2A dispatch disposition', () => {
  test('cross-thread handoff terminalizes only with durable cross-post provenance', async () => {
    const h = await harness({
      sourceCatId: 'codex-sol',
      crossPostSourceThreadId: 'thread-source',
    });

    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
    assert.deepEqual(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned'),
      [
        {
          sourceEventId: `dispatch-disposition:inv-1:${h.source.id}`,
          subjectKey: 'ball:thread:thread-1',
          kind: 'ball.dispatch_dispositioned',
          classification: 'state-changing',
          payload: {
            catId: 'codex-sol',
            fromCatId: 'codex-sol',
            invocationId: 'inv-1',
            sourceMessageId: h.source.id,
            disposition: 'completed',
          },
          at: 2_000,
        },
      ],
    );
  });

  test('same-thread self handoff remains rejected even with an exact handed event', async () => {
    const h = await harness({ sourceCatId: 'codex-sol' });

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      /^A2ADispatchDispositionError: a2a_dispatch_disposition_source_mismatch$/,
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });
});
