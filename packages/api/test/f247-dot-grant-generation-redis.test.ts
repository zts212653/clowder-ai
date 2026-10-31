import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { RedisCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
test(
  'Redis atomically refreshes pending dot generations without changing Pro or active/consumed returns',
  { skip: redisIsolationSkipReason(url) },
  async () => {
    assertRedisIsolationOrThrow(url, 'f247-dot-grant-generation');
    assert.ok(url);
    const redis = new Redis(url, { keyPrefix: `f247-dot-retry:${randomUUID()}:`, maxRetriesPerRequest: 0 });
    const store = new RedisCloudReturnGrantStore(redis);
    try {
      for (const targetCatId of ['gpt-dot', 'gpt-pro']) {
        const scope = { threadId: 'thread', userId: 'owner', sourceMessageId: 'source', targetCatId };
        await store.issue({ ...scope, dispatchInvocationId: 'first' });
        await store.issue({ ...scope, dispatchInvocationId: 'retry' });
        const pending = await store.claim(scope);
        assert.ok(pending.ok);
        assert.equal(pending.dispatchInvocationId, targetCatId === 'gpt-dot' ? 'retry' : 'first');
        if (targetCatId === 'gpt-dot') {
          assert.deepEqual(await store.issue({ ...scope, dispatchInvocationId: 'later' }), {
            ok: false,
            reason: 'in_flight',
          });
          await redis.pexpire(pending.claimKey, 1);
          await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal((await store.issue({ ...scope, dispatchInvocationId: 'later' })).ok, true);
          assert.equal(await store.commit(pending), false, 'expired older append cannot consume the refreshed grant');
          const next = await store.claim(scope);
          assert.ok(next.ok);
          assert.equal(next.dispatchInvocationId, 'later');
          assert.equal(await store.commit(next), true);
        } else {
          assert.equal(await store.commit(pending), true);
        }
        await store.issue({ ...scope, dispatchInvocationId: 'completed-retry' });
        assert.deepEqual(await store.claim(scope), { ok: false, reason: 'consumed' });
      }
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
