import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { readRepairFixture } from './helpers/read-repair-fixture.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

test(
  'HTTP read repair retires an abandoned Host turn through real Redis without fabricating teardown',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'active read-repair Redis integration');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    t.after(async () => {
      await cleanupPrefixedRedisKeys(redis, ['turnexec:*']);
      await redis.quit();
    });
    await redis.ping();
    const h = await readRepairFixture(t, new RedisTurnExecutionStore(redis));
    await h.poll();
    await Promise.all([h.poll('thread'), h.poll('project'), h.poll('all')]);
    assert.equal(h.transition.mock.callCount(), 1);
    assert.equal(h.errors().length, 0);
    assert.equal(h.parent.status, 'failed');
    const restartedStore = new RedisTurnExecutionStore(redis);
    const child = await restartedStore.get(h.childId);
    assert.equal(child.status, 'failed');
    assert.equal(child.providerTeardownAt, undefined);
    assert.equal(await redis.ttl(`turnexec:record:${h.childId}`), -1);
    h.advance(1);
    await restartedStore.recordProviderTeardown(h.childId, Date.now());
    assert.ok((await restartedStore.get(h.childId)).providerTeardownAt);
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 1, 'late physical evidence never replays Host termination');
  },
);
