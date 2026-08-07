import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe:unread-visibility-cursor-test:';

describe('Redis unread summary visibility cursor contract', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let RedisThreadReadStateStore;
  let createRedisClient;
  let createFreshnessClosure;
  let scanFreshnessClosurePreflight;
  let redis;
  let messageStore;
  let readStateStore;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis unread summary visibility cursor contract');
    [
      { RedisMessageStore },
      { RedisThreadReadStateStore },
      { createRedisClient },
      { createFreshnessClosure },
      { scanFreshnessClosurePreflight },
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'),
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/freshness/FreshnessClosureStateMachine.js'),
      import('../dist/domains/cats/services/freshness/FreshnessClosurePreflight.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
    readStateStore = new RedisThreadReadStateStore(redis);
  });

  async function appendVisibilityInversion(threadId, userId) {
    const baseTs = Date.now() - 10_000;
    const c = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'C: visible first with the later raw id',
      mentions: [],
      timestamp: baseTs + 200,
      threadId,
    });
    const q = await messageStore.append({
      userId,
      catId: 'codex',
      content: 'Q: visible second with the earlier raw id',
      mentions: [],
      timestamp: baseTs + 100,
      threadId,
      deliveryStatus: 'queued',
    });

    assert.ok(q.id < c.id, 'fixture must invert raw-id order relative to visibility order');
    const latest = await messageStore.getLatestVisibleCursor(threadId);
    assert.equal(latest?.messageId, q.id, 'Q must be the visibility-domain latest message');
    return { baseTs, c, q, latest };
  }

  it('does not resurrect an older visible message after a v1 read cursor', async () => {
    const userId = 'user-v1';
    const threadId = 'thread-v1-visibility-inversion';
    const { q } = await appendVisibilityInversion(threadId, userId);

    assert.equal(await readStateStore.ack(userId, threadId, q.id), true);

    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 0, hasUserMention: false },
    ]);
  });

  it('counts messages appended after a v2 read cursor', async () => {
    const userId = 'user-v2';
    const threadId = 'thread-v2-visibility-inversion';
    const { baseTs, latest } = await appendVisibilityInversion(threadId, userId);
    assert.ok(latest?.cursor.startsWith('v2:'), 'fixture must expose a canonical v2 cursor');
    assert.equal(await readStateStore.ack(userId, threadId, latest.cursor), true);

    await messageStore.append({
      userId,
      catId: 'opus',
      content: 'D: genuinely unread after the v2 cursor',
      mentions: [],
      timestamp: baseTs + 300,
      threadId,
    });

    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);
  });

  it('includes a late-visible message when the raw closure frontier is unchanged', async () => {
    const userId = 'user-closure';
    const threadId = 'thread-closure-visibility-inversion';
    const origin = await messageStore.append({
      userId,
      catId: null,
      content: 'origin request',
      mentions: ['codex-sol'],
      timestamp: Date.now() - 20_000,
      threadId,
    });
    const { c, q } = await appendVisibilityInversion(threadId, userId);
    const closure = createFreshnessClosure({
      id: 'closure-redis-visibility-inversion',
      userId,
      threadId,
      catId: 'codex-sol',
      invocationId: 'invocation-redis-visibility-inversion',
      turnInvocationId: 'invocation-redis-visibility-inversion',
      originTriggerMessageId: origin.id,
      draftContent: 'answer before Q became visible',
      requiredMessageIds: [c.id],
      requiredFrontierMessageId: c.id,
      observedRawFrontierMessageId: c.id,
      now: Date.now(),
    });

    const result = await scanFreshnessClosurePreflight({ closure, messageStore });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, [q.id, c.id]);
    assert.equal(result.observedRawFrontierMessageId, c.id);
  });

  // #1304: Stale cursor (message pruned from hash + visibility ZSET) must
  // return 0 unread, not scan the entire visibility set as unread.
  it('returns 0 unread when read cursor message is pruned (stale cursor)', async () => {
    const userId = 'user-stale-cursor';
    const threadId = 'thread-stale-cursor';

    const msg = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'message that will be pruned',
      mentions: [],
      timestamp: Date.now() - 5_000,
      threadId,
    });
    await messageStore.append({
      userId,
      catId: 'codex',
      content: 'later message still visible',
      mentions: [],
      timestamp: Date.now() - 1_000,
      threadId,
    });

    // Ack cursor to the first message
    assert.equal(await readStateStore.ack(userId, threadId, msg.id), true);
    // Verify 0 unread before pruning
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);

    // Prune the acked message: delete hash + ZREM from visibility ZSET
    await redis.del(`msg:${msg.id}`);
    await redis.zrem(`msg:visibility:${threadId}`, msg.id);

    // Stale cursor: position can't be resolved → must return 0 unread
    // Old code (zrange 0 -1) would scan all visible messages → 1+ unread
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 0, hasUserMention: false },
    ]);
  });
});
