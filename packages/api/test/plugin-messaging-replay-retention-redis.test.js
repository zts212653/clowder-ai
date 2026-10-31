import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f288-replay-retention-${process.pid}:`;

test(
  'Redis replay floor is monotonic, restart-safe, owner-scoped, and fenced after revocation',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PluginMessagingReplayRetentionRedis');
    const [{ createRedisClient }, { RedisCursorStore }] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/messaging/stores/redis.js'),
    ]);
    const redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    t.after(() => redis.quit());

    const store = new RedisCursorStore(redis);
    const subscriptionId = `subscription-${process.pid}`;
    const handleId = `handle-${process.pid}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'plugin-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 2,
      lastDeliveredSequence: 4,
      replayFloorSequence: 0,
    });

    assert.deepEqual(
      await Promise.all([
        store.advanceReplayFloor('plugin-a', subscriptionId, 3),
        store.advanceReplayFloor('plugin-a', subscriptionId, 9),
        store.advanceReplayFloor('plugin-a', subscriptionId, 7),
      ]),
      [true, true, true],
    );
    await store.advanceReplayFloor('plugin-a', subscriptionId, 1);

    const reloaded = await new RedisCursorStore(redis).get('plugin-a', subscriptionId);
    assert.deepEqual(
      {
        ackedSequence: reloaded.ackedSequence,
        lastDeliveredSequence: reloaded.lastDeliveredSequence,
        replayFloorSequence: reloaded.replayFloorSequence,
      },
      { ackedSequence: 2, lastDeliveredSequence: 4, replayFloorSequence: 9 },
    );

    assert.equal(await store.advanceReplayFloor('plugin-b', subscriptionId, 10), false);
    assert.equal(await store.get('plugin-b', subscriptionId), null);
    assert.equal(await store.revokeByHandle(handleId, 77), 1);
    assert.equal(await store.advanceReplayFloor('plugin-a', subscriptionId, 10), false);
    assert.equal((await store.get('plugin-a', subscriptionId)).replayFloorSequence, 9);
  },
);
