import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryCloudReturnGrantStore,
  RedisCloudReturnGrantStore,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';

const claims = {
  threadId: 'thread-f247',
  userId: 'alice',
  sourceMessageId: 'source-f247',
  dispatchInvocationId: 'dispatch-f247',
  targetCatId: 'gpt-pro',
};

describe('F247 server-custodied exact-source return grant', () => {
  it('leases one exact grant, releases a failed append, then consumes the durable return', async () => {
    const store = new MemoryCloudReturnGrantStore();
    assert.deepEqual(await store.issue(claims), { ok: true, status: 'issued' });

    const first = await store.claim({
      threadId: claims.threadId,
      userId: claims.userId,
      sourceMessageId: claims.sourceMessageId,
      targetCatId: claims.targetCatId,
    });
    assert.equal(first.ok, true);
    assert.equal(first.dispatchInvocationId, claims.dispatchInvocationId);

    assert.deepEqual(
      await store.claim({
        threadId: claims.threadId,
        userId: claims.userId,
        sourceMessageId: claims.sourceMessageId,
        targetCatId: claims.targetCatId,
      }),
      { ok: false, reason: 'in_flight' },
    );

    assert.equal(await store.release(first), true);
    const retry = await store.claim({
      threadId: claims.threadId,
      userId: claims.userId,
      sourceMessageId: claims.sourceMessageId,
      targetCatId: claims.targetCatId,
    });
    assert.equal(retry.ok, true);
    assert.equal(await store.commit(retry), true);

    assert.deepEqual(
      await store.claim({
        threadId: claims.threadId,
        userId: claims.userId,
        sourceMessageId: claims.sourceMessageId,
        targetCatId: claims.targetCatId,
      }),
      { ok: false, reason: 'consumed' },
    );
  });

  it('does not authorize a substituted source, thread, user, or target cat', async () => {
    const store = new MemoryCloudReturnGrantStore();
    await store.issue(claims);

    for (const mismatch of [
      { sourceMessageId: 'source-other' },
      { threadId: 'thread-other' },
      { userId: 'mallory' },
      { targetCatId: 'other-cloud-cat' },
    ]) {
      assert.deepEqual(
        await store.claim({
          threadId: claims.threadId,
          userId: claims.userId,
          sourceMessageId: claims.sourceMessageId,
          targetCatId: claims.targetCatId,
          ...mismatch,
        }),
        { ok: false, reason: 'not_found' },
      );
    }
  });

  it('keeps an issued grant available across API composition restarts', async () => {
    const values = new Map();
    const redis = {
      async set(key, value, ...args) {
        if (args.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
      async get(key) {
        return values.get(key) ?? null;
      },
      async eval() {
        throw new Error('not used by this restart assertion');
      },
    };
    const beforeRestart = new RedisCloudReturnGrantStore(redis);
    assert.deepEqual(await beforeRestart.issue(claims), { ok: true, status: 'issued' });

    const afterRestart = new RedisCloudReturnGrantStore(redis);
    const claimed = await afterRestart.claim({
      threadId: claims.threadId,
      userId: claims.userId,
      sourceMessageId: claims.sourceMessageId,
      targetCatId: claims.targetCatId,
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.dispatchInvocationId, claims.dispatchInvocationId);
  });
});
