import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

for (const read of ['window', 'drill']) {
  test(`ordinary ${read} read can settle the new source without replaying the primary`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    assert.equal((await h.complete()).status, 200);
    const source = await h.addSource('second request');
    const body = await h.get(
      read === 'window'
        ? '/api/callbacks/thread-context?responseMode=full'
        : `/api/callbacks/get-message?messageId=${source.id}&mode=full`,
    );
    assert.match(JSON.stringify(body), /second request/);
    assert.ok(
      h.messageStore
        .getById(source.id)
        .queueCustody.bodyExposures.some((e) => e.invocationId === h.identity.invocationId),
    );
    assert.deepEqual(
      body.a2aDispatchDisposition?.candidates.map((c) => c.sourceMessageId),
      [source.id],
    );
    const result = await h.complete(source.id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.sourceMessageId, source.id);
    assert.equal(result.body.outcome, 'applied');
    assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, ['codex-sol']);
    assert.equal((await h.complete(source.id)).body.outcome, 'replayed');
    await h.processor.onInvocationComplete('thread-1', 'codex-sol', 'failed', h.identity.invocationId, []);
    assert.deepEqual(h.messageStore.getById(source.id).queueCustody.failedByCatIds, []);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });
}
