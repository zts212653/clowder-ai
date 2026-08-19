import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
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
  let threadsRoutes;
  let ThreadStore;
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
      { threadsRoutes },
      { ThreadStore },
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'),
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/freshness/FreshnessClosureStateMachine.js'),
      import('../dist/domains/cats/services/freshness/FreshnessClosurePreflight.js'),
      import('../dist/routes/threads.js'),
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
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

  // #1304 reopened: rollout-gated primary cursors can be pruned, but the
  // canonical visibility anchor must still preserve genuinely later unread.
  it('keeps later unread messages after the primary read cursor is pruned', async () => {
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

    // Persist the rollout-gated v1 primary plus its durable v2 anchor.
    const canonicalCursor = await messageStore.canonicalizeCursor(msg.id, threadId);
    assert.ok(canonicalCursor.startsWith('v2:'));
    assert.equal(await readStateStore.ack(userId, threadId, msg.id, canonicalCursor), true);
    // Verify 0 unread before pruning
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);

    // Prune the acked message: delete hash + ZREM from visibility ZSET
    await redis.del(`msg:${msg.id}`);
    await redis.zrem(`msg:visibility:${threadId}`, msg.id);

    // The pruned primary must not erase the position of the durable anchor.
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);
  });

  it('advances from a pruned primary by comparing against its durable anchor', async () => {
    const userId = 'user-pruned-primary-advance';
    const threadId = 'thread-pruned-primary-advance';
    const first = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'first read message',
      mentions: [],
      timestamp: Date.now() - 2_000,
      threadId,
    });
    const firstCursor = await messageStore.canonicalizeCursor(first.id, threadId);
    assert.equal(await readStateStore.ack(userId, threadId, first.id, firstCursor), true);

    await redis.del(`msg:${first.id}`);
    await redis.zrem(`msg:visibility:${threadId}`, first.id);

    const later = await messageStore.append({
      userId,
      catId: 'codex-sol',
      content: 'later visible message',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const laterCursor = await messageStore.canonicalizeCursor(later.id, threadId);

    assert.equal(await readStateStore.ack(userId, threadId, later.id, laterCursor), true);
    const state = await readStateStore.get(userId, threadId);
    assert.equal(state.lastReadMessageId, later.id);
    assert.equal(state.lastReadVisibilityCursor, laterCursor);
  });

  it('read/latest repairs a legacy stale primary, then preserves a genuinely new unread message', async () => {
    const userId = 'user-read-latest-repair';
    const threadStore = new ThreadStore();
    const thread = threadStore.create(userId, 'Reopened #1304 integration');
    const latest = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'latest message the user opens',
      mentions: [],
      timestamp: Date.now() - 1_000,
      threadId: thread.id,
    });
    assert.equal(await readStateStore.ack(userId, thread.id, '0000000000000001-pruned-legacy'), true);

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${thread.id}/read/latest`,
        headers: { 'x-cat-cafe-user': userId },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().advanced, true);
      assert.equal(response.json().caughtUp, true);

      const repaired = await readStateStore.get(userId, thread.id);
      assert.equal(repaired.lastReadMessageId, latest.id);
      assert.ok(repaired.lastReadVisibilityCursor?.startsWith('v2:'));

      await messageStore.append({
        userId,
        catId: 'codex-sol',
        content: 'genuinely new unread message',
        mentions: [],
        timestamp: Date.now(),
        threadId: thread.id,
      });
      assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [thread.id], messageStore), [
        { threadId: thread.id, unreadCount: 1, hasUserMention: false },
      ]);
    } finally {
      await app.close();
    }
  });
});
