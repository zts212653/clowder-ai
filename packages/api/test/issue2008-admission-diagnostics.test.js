import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture } from './helpers/stop-private-fixture.js';

test('#2008 targetless retry barrier reports its actual retry instead of busy slots', async (t) => {
  const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 1000 } });
  const source = await h.send('unknown recipient', []);
  await h.send('later explicit', ['codex']);
  t.after(() => h.processor.retryDeferrals.forget(source.entry.id));
  const observations = [];
  h.processor.deps.log.info = (data) => observations.push(data);
  const failure = new Error('targetless history read unavailable');
  const read = h.messages.getByIdempotencyKey.bind(h.messages);
  h.messages.getByIdempotencyKey = (...args) => {
    if (args[2].includes(source.entry.id)) throw failure;
    return read(...args);
  };
  await assert.rejects(h.processor.requestDrain('thread'), (error) => error === failure);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const diagnostic = observations.findLast((data) => data.entryId === source.entry.id && data.outcome);
  assert.ok(diagnostic, 'the follow-up scan must explain its waiting barrier');
  assert.equal(diagnostic.outcome, 'waiting_for_retry');
  assert.equal(diagnostic.deferredForBusySlot, 0, 'no slot is busy in this fixture');
  assert.equal(diagnostic.deferredForRetry, 1);
  assert.equal(diagnostic.retryAt, h.processor.retryDeferrals.retryAt(source.entry.id));
  assert.deepEqual(h.starts, []);
});
