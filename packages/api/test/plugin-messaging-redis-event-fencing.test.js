/** Redis parity for K-1 append emission lease fencing. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f288-event-fence-${process.pid}:`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Redis append emission fencing', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisAppendLock;
  let RedisEventLogStore;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PluginMessagingRedisEventFence');
    ({ RedisAppendLock, RedisEventLogStore } = await import('../dist/domains/messaging/stores/redis.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  test('INV-14: stale Redis lease cannot consume an event sequence', async () => {
    const messageId = `msg-${Date.now()}`;
    const threadId = `thread-${Date.now()}`;
    const lock = new RedisAppendLock(redis);
    const log = new RedisEventLogStore(redis);
    const stale = await lock.acquire(messageId, 80);
    assert.equal(stale.messageId, messageId);
    assert.equal(typeof stale.token, 'string');
    await sleep(140);
    const successor = await lock.acquire(messageId, 60_000);

    const result = await log.append(
      threadId,
      `append:${messageId}:op-1`,
      {
        eventId: `ev-${messageId}-op-1`,
        type: 'message.elements.append',
        messageId,
        threadId,
        operationId: 'op-1',
        revision: 2,
        elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'stale' } }],
      },
      1,
      stale,
    );

    assert.equal(result.fencedOut, true);
    assert.equal(await log.headSequence(threadId), 0);
    await lock.release(messageId, successor);
  });
});
