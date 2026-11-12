import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRetryFixture } from './helpers/memory-write-retry-fixture.js';

for (const kind of ['entity', 'event'] as const) {
  for (const fault of ['source lookup failure', 'missing origin validator'] as const) {
    test(`${kind}: ${fault} preserves the original retry key and remains recoverable`, async (t) => {
      const f = await memoryRetryFixture(kind);
      t.after(() => f.app.close());
      const first = await f.post(await f.auth());
      assert.equal(first.statusCode, 200, first.body);
      const sourceRead = f.messages.getById;
      const validateOrigin = f.ingress.validateOrigin;
      if (fault === 'source lookup failure') {
        f.messages.getById = () => {
          throw Object.assign(new Error('Source store temporarily disconnected'), { code: 'ECONNRESET' });
        };
      } else {
        Object.defineProperty(f.ingress, 'validateOrigin', { value: undefined, configurable: true });
      }
      const failed = await f.post(await f.auth());
      assert.equal(failed.statusCode, 500, failed.body);
      assert.notEqual(failed.json().error, 'origin_not_eligible');
      assert.equal(await f.store.getDedupProposalId(f.owner, f.input.clientRequestId), first.json().proposalId);

      f.messages.getById = sourceRead;
      Object.defineProperty(f.ingress, 'validateOrigin', { value: validateOrigin, configurable: true });
      const recovered = await f.post(await f.auth());
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.json().proposalId, first.json().proposalId);
      assert.equal(
        f.messages.getByThread(f.thread.id, 100, f.owner).filter((message) => message.extra?.rich?.blocks.length)
          .length,
        1,
      );
    });
  }

  test(`${kind}: a staged retry directs the caller back to its original thread`, async (t) => {
    const f = await memoryRetryFixture(kind);
    t.after(() => f.app.close());
    const commit = f.store.commitEnvelope.bind(f.store);
    f.store.commitEnvelope = async () => {
      throw new Error('Lost envelope acknowledgement');
    };
    assert.equal((await f.post(await f.auth())).statusCode, 500);
    const other = f.threads.create(f.owner, 'Another thread');
    const retry = await f.post(await f.auth(f.origin, 'opus', other.id));
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(retry.json().status, 'origin_thread_required');
    assert.equal(retry.json().sourceThreadId, f.thread.id);
    f.store.commitEnvelope = commit;
    assert.equal((await f.post(await f.auth())).statusCode, 200);
  });
}
