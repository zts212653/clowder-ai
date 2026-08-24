/**
 * RedisThreadReadStateStore tests (F069)
 * 有 Redis → 测全量；无 Redis → skip
 *
 * Real data model: cat messages and user messages share the same userId (tenant ID).
 * User's own message: catId=null, no source.
 * Cat message: catId='opus' (or any CatId).
 * Connector message: source={...}.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisThreadReadStateStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisThreadReadStateStore;
  let RedisMessageStore;
  let createRedisClient;
  let redis;
  let store;
  let messageStore;
  let connected = false;
  let testSeq = 0;

  const uniqueId = (prefix) => `${prefix}-${++testSeq}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisThreadReadStateStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js');
    RedisThreadReadStateStore = storeModule.RedisThreadReadStateStore;
    const msgModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = msgModule.RedisMessageStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-read-state-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisThreadReadStateStore(redis);
    messageStore = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['read-state:*', 'msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
  });

  // --- ack basics ---

  it('get() returns null for unread thread', async () => {
    const tid = uniqueId('t');
    const result = await store.get('user1', tid);
    assert.equal(result, null);
  });

  it('ack() sets cursor and get() retrieves it', async () => {
    const tid = uniqueId('t');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, true);

    const state = await store.get('user1', tid);
    assert.equal(state.userId, 'user1');
    assert.equal(state.threadId, tid);
    assert.equal(state.lastReadMessageId, 'msg-001');
    assert.ok(state.updatedAt > 0);
  });

  it('ack() persists a canonical visibility anchor beside a rollout-gated primary cursor', async () => {
    const tid = uniqueId('t-anchor');
    const canonical = 'v2:0000000000000042:msg-001';

    assert.equal(await store.ack('user1', tid, 'msg-001', canonical), true);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-001');
    assert.equal(state.lastReadVisibilityCursor, canonical);
  });

  it('ack() backfills a missing canonical anchor on an idempotent primary cursor', async () => {
    const tid = uniqueId('t-anchor-backfill');
    const canonical = 'v2:0000000000000042:msg-001';
    assert.equal(await store.ack('user1', tid, 'msg-001'), true);

    assert.equal(await store.ack('user1', tid, 'msg-001', canonical), false);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-001');
    assert.equal(state.lastReadVisibilityCursor, canonical);
  });

  it('replaceReadCursorIfEqual() commits the repaired primary and canonical anchor atomically', async () => {
    const tid = uniqueId('t-repair-anchor');
    const canonical = 'v2:0000000000000042:msg-latest';
    assert.equal(await store.ack('user1', tid, 'msg-stale'), true);

    assert.equal(await store.replaceReadCursorIfEqual('user1', tid, 'msg-stale', 'msg-latest', canonical), true);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-latest');
    assert.equal(state.lastReadVisibilityCursor, canonical);
  });

  it('replaceReadCoordinateIfEqual() rejects an anchor-only concurrent change', async () => {
    const tid = uniqueId('t-repair-coordinate-race');
    const oldAnchor = 'v2:0000000000000040:msg-stale';
    const concurrentAnchor = 'v2:0000000000000041:msg-concurrent';
    const repairedAnchor = 'v2:0000000000000042:msg-latest';
    assert.equal(await store.ack('user1', tid, 'msg-stale', oldAnchor), true);
    assert.equal(await store.ack('user1', tid, 'msg-stale', concurrentAnchor), false);

    assert.equal(
      await store.replaceReadCoordinateIfEqual(
        'user1',
        tid,
        { lastReadMessageId: 'msg-stale', lastReadVisibilityCursor: oldAnchor },
        { lastReadMessageId: 'msg-latest', lastReadVisibilityCursor: repairedAnchor },
      ),
      false,
    );

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-stale');
    assert.equal(state.lastReadVisibilityCursor, concurrentAnchor);
  });

  it('ack() monotonic: rejects older message ID', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-002');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, false);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-002');
  });

  it('ack() monotonic: accepts newer message ID', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    const advanced = await store.ack('user1', tid, 'msg-003');
    assert.equal(advanced, true);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-003');
  });

  it('ack() same ID is no-op', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, false);
  });

  // --- getUnreadSummaries (realistic data model: same userId for user + cat messages) ---

  it('getUnreadSummaries() counts cat messages as unread', async () => {
    const tid = uniqueId('t');
    // Cat messages share same userId as tenant — catId distinguishes them
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'world',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'test',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].threadId, tid);
    assert.equal(summaries[0].unreadCount, 2);
    assert.equal(summaries[0].hasUserMention, false);
  });

  it('getUnreadSummaries() counts published queued cat speech but not queued user or system work', async () => {
    const tid = uniqueId('t-published');
    const anchor = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'read anchor',
      mentions: [],
      timestamp: Date.now() - 4000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'queued user work',
      mentions: ['opus'],
      timestamp: Date.now() - 3000,
      threadId: tid,
      deliveryStatus: 'queued',
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'codex-sol',
      content: 'published source-cat seed',
      mentions: ['opus'],
      timestamp: Date.now() - 2000,
      threadId: tid,
      deliveryStatus: 'queued',
      mentionsUser: true,
    });
    await messageStore.append({
      userId: 'system',
      catId: 'system',
      content: 'queued internal system event',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
      deliveryStatus: 'queued',
    });
    await store.ack('user1', tid, anchor.id);

    const [summary] = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summary.unreadCount, 1);
    assert.equal(summary.hasUserMention, true);
  });

  it('keeps a read published cat seed before replies when its execution custody terminalizes', async () => {
    const tid = uniqueId('t-published-cursor');
    const base = Date.now();
    const seed = await messageStore.append({
      userId: 'user1',
      catId: 'codex-sol',
      content: 'published source-cat seed',
      mentions: ['opus'],
      timestamp: base,
      threadId: tid,
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-published-cursor',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: base,
        updatedAt: base,
      }),
    });
    await store.ack('user1', tid, seed.id);
    const firstReply = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'first reply',
      mentions: [],
      timestamp: base + 10,
      threadId: tid,
    });
    const secondReply = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'second reply',
      mentions: [],
      timestamp: base + 20,
      threadId: tid,
    });

    const terminal = makeQueuedMessageCustody({
      entryId: 'entry-published-cursor',
      revision: 2,
      status: 'terminal',
      allTargetCats: ['opus'],
      pendingTargetCats: [],
      seenByCatIds: ['opus'],
      seenInvocationIdByCatId: { opus: 'inv-published-cursor' },
      bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-published-cursor', seenAt: base + 25 }],
      handledByCatIds: ['opus'],
      targetOutcomeByCatId: {
        opus: {
          invocationId: 'inv-published-cursor',
          disposition: 'completed_with_turn',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-published-cursor' },
          handledAt: base + 50,
        },
      },
      createdAt: base,
      updatedAt: base + 50,
    });
    const transitioned = await messageStore.transitionQueueCustody(seed.id, {
      expectedRevision: 1,
      next: terminal,
      deliveredAt: base + 50,
    });

    assert.equal(transitioned.kind, 'updated');
    assert.equal(transitioned.message.deliveredAt, base + 50, 'execution delivery keeps its actual terminal time');
    assert.equal(transitioned.message.timelineOrderAt, base, 'publication order is persisted separately');
    assert.equal(
      await redis.zscore(`msg:thread:${tid}`, seed.id),
      String(base),
      'timeline score keeps the original publication position',
    );
    const [summary] = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summary.unreadCount, 2);
    assert.deepEqual(
      (
        await messageStore.getByThreadAfter(tid, seed.id, undefined, 'user1', {
          includeQueuedCatMessages: true,
        })
      ).map((message) => message.id),
      [firstReply.id, secondReply.id],
    );
  });

  it('getUnreadSummaries() excludes user own messages (catId=null)', async () => {
    const tid = uniqueId('t');
    // Cat message (catId='opus') — should be counted
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'cat reply',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    // User's own message (catId=null) — should NOT be counted
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'my question',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    // Cat reply (catId='opus') — should be counted
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'cat reply 2',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    // Only 1 unread (cat reply 2), user's own message excluded
    assert.equal(summaries[0].unreadCount, 1);
  });

  it('getUnreadSummaries() excludes deleted messages from count', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    const m2 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'to delete',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'keep',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);
    await messageStore.softDelete(m2.id, 'user1');

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    // Only 1 unread (keep), deleted message excluded
    assert.equal(summaries[0].unreadCount, 1);
  });

  it('getUnreadSummaries() detects mentionsUser', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: '@co-creator look',
      mentions: [],
      mentionsUser: true,
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].hasUserMention, true);
  });

  it('getUnreadSummaries() returns 0 for fully read thread', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });
    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].unreadCount, 0);
  });

  it('getUnreadSummaries() treats no cursor as fully read (cold-start guard)', async () => {
    const tid = uniqueId('t');
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'world',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });

    // No ack → no cursor → should return 0 (not "all unread")
    // Pre-F069 threads have no cursor; treating them as all-unread
    // causes badges to reappear on every page refresh.
    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].unreadCount, 0);
    assert.equal(summaries[0].hasUserMention, false);
  });

  it('getUnreadSummaries() handles multiple threads (mixed cursor states)', async () => {
    const tA = uniqueId('t');
    const tB = uniqueId('t');
    const mA1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'a1',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tA,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'a2',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tA,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'b',
      mentions: [],
      timestamp: Date.now(),
      threadId: tB,
    });

    // Ack thread A at first message → 1 unread; thread B has no cursor → 0 (cold-start)
    await store.ack('user1', tA, mA1.id);

    const summaries = await store.getUnreadSummaries('user1', [tA, tB], messageStore);
    const map = new Map(summaries.map((s) => [s.threadId, s]));
    assert.equal(map.get(tA).unreadCount, 1);
    assert.equal(map.get(tB).unreadCount, 0); // no cursor = fully read
  });

  // --- deleteByThread ---

  it('deleteByThread() cleans up cursor', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    await store.deleteByThread(tid);
    const state = await store.get('user1', tid);
    assert.equal(state, null);
  });

  it('different users have independent cursors', async () => {
    const tid = uniqueId('t');
    await store.ack('userA', tid, 'msg-003');
    await store.ack('userB', tid, 'msg-001');

    const stateA = await store.get('userA', tid);
    const stateB = await store.get('userB', tid);
    assert.equal(stateA.lastReadMessageId, 'msg-003');
    assert.equal(stateB.lastReadMessageId, 'msg-001');
  });
});
