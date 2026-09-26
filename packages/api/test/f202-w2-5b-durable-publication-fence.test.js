/**
 * F202 W2-5b review P1 (PR #1487 comment 5828208840) — a durable publication fence outlives
 * event-log retention, in memory and in Redis.
 *
 * The event log dedupes a key only while its event is retained: trimming removes the dedupe entry
 * with the event. The outbound media job may append `publish:<id>:1`, fail to record `published`,
 * and retry at recovery after a trim — without a fence that outlives retention, the retry appends
 * the same message a second time. An append that asks for the fence gets the first sequence back
 * instead; one that does not ask keeps the old retention-window behavior. The fence has no expiry:
 * the publisher releases it once the publication is recorded (re-review P1, comment 5828779117).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f202-w2-5b-fence-${process.pid}:`;

function publishEvent(messageId) {
  return {
    eventId: `ev_pub_${messageId}_1`,
    type: 'message.publish',
    envelope: { messageId, threadId: 'thread', payload: { elements: [] } },
  };
}

async function fenceSurvivesTrim(log, threadId) {
  const first = await log.append(threadId, 'publish:m1:1', publishEvent('m1'), 1, undefined, { durableFence: true });
  await log.append(threadId, 'publish:m2:1', publishEvent('m2'), 1);
  assert.deepEqual(
    (await log.readAfter(threadId, 0, 10)).map((event) => event.envelope.messageId),
    ['m2'],
    'retention 1 trimmed the fenced event and its window dedupe entry',
  );

  const retry = await log.append(threadId, 'publish:m1:1', publishEvent('m1'), 1, undefined, { durableFence: true });

  assert.deepEqual(retry, { sequence: first.sequence, deduped: true, fencedOut: false });
  assert.deepEqual(
    (await log.readAfter(threadId, 0, 10)).map((event) => event.envelope.messageId),
    ['m2'],
    'the retry appended nothing',
  );
}

async function releaseEndsTheFence(log, threadId) {
  const first = await log.append(threadId, 'publish:r1:1', publishEvent('r1'), 1, undefined, { durableFence: true });
  await log.append(threadId, 'publish:r2:1', publishEvent('r2'), 1);

  await log.releaseFence(threadId, 'publish:r1:1');
  const after = await log.append(threadId, 'publish:r1:1', publishEvent('r1'), 1, undefined, { durableFence: true });

  assert.equal(after.deduped, false, 'a released fence no longer dedupes');
  assert.ok(after.sequence > first.sequence);
}

async function unfencedKeepsWindowBehavior(log, threadId) {
  await log.append(threadId, 'publish:m3:1', publishEvent('m3'), 1);
  await log.append(threadId, 'publish:m4:1', publishEvent('m4'), 1);

  const again = await log.append(threadId, 'publish:m3:1', publishEvent('m3'), 1);

  assert.equal(again.deduped, false, 'without the fence, a trimmed key appends again as before');
}

describe('F202 W2-5b — durable publication fence (memory)', () => {
  test('a fenced key is deduped after its event is trimmed', async () => {
    const { MemoryEventLogStore } = await import('../dist/domains/messaging/stores/memory.js');
    await fenceSurvivesTrim(new MemoryEventLogStore(), 'thread-memory');
  });

  test('an unfenced key keeps the retention-window dedupe', async () => {
    const { MemoryEventLogStore } = await import('../dist/domains/messaging/stores/memory.js');
    await unfencedKeepsWindowBehavior(new MemoryEventLogStore(), 'thread-memory-unfenced');
  });

  test('releasing a fence ends it', async () => {
    const { MemoryEventLogStore } = await import('../dist/domains/messaging/stores/memory.js');
    await releaseEndsTheFence(new MemoryEventLogStore(), 'thread-memory-release');
  });
});

describe('F202 W2-5b — durable publication fence (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisEventLogStore;
  let MessagingKeys;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F202W25bDurableFence');
    ({ RedisEventLogStore } = await import('../dist/domains/messaging/stores/redis.js'));
    ({ MessagingKeys } = await import('../dist/domains/messaging/stores/redis-keys.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  // Re-review P1 (…5828779117): a TTL let the fence expire while a `publishing` row could still be
  // retried. The fence has no expiry; the publisher releases it once `published` is recorded.
  test('a fenced key is deduped after its event is trimmed, and the fence never expires by itself', async () => {
    const threadId = `thread-${Date.now()}`;
    const log = new RedisEventLogStore(redis);

    await fenceSurvivesTrim(log, threadId);

    const fenceKey = MessagingKeys.eventFence(threadId, encodeURIComponent('publish:m1:1'));
    assert.equal(await redis.ttl(fenceKey), -1, 'no TTL: the fence lasts until it is released');
    await log.releaseFence(threadId, 'publish:m1:1');
    assert.equal(await redis.exists(fenceKey), 0);
  });

  test('releasing a fence ends it', async () => {
    await releaseEndsTheFence(new RedisEventLogStore(redis), `thread-release-${Date.now()}`);
  });

  test('an unfenced key keeps the retention-window dedupe', async () => {
    await unfencedKeepsWindowBehavior(new RedisEventLogStore(redis), `thread-unfenced-${Date.now()}`);
  });
});
