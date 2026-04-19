/**
 * RedisMessageStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisMessageStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = storeModule.RedisMessageStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    // Connectivity check: skip all tests if Redis is unreachable
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-message-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  it('append() stores message and returns with id', async () => {
    const msg = await store.append({
      userId: 'user1',
      catId: null,
      content: 'hello',
      mentions: ['opus'],
      timestamp: Date.now(),
    });
    assert.ok(msg.id);
    assert.equal(msg.content, 'hello');
    assert.equal(msg.userId, 'user1');
  });

  it('getRecent() returns messages in chronological order', async () => {
    const now = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'first', mentions: [], timestamp: now });
    await store.append({ userId: 'u', catId: 'opus', content: 'second', mentions: [], timestamp: now + 1 });
    await store.append({ userId: 'u', catId: null, content: 'third', mentions: [], timestamp: now + 2 });

    const recent = await store.getRecent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].content, 'first');
    assert.equal(recent[2].content, 'third');
  });

  it('getRecent() filters by userId', async () => {
    const now = Date.now();
    await store.append({ userId: 'alice', catId: null, content: 'alice msg', mentions: [], timestamp: now });
    await store.append({ userId: 'bob', catId: null, content: 'bob msg', mentions: [], timestamp: now + 1 });

    const aliceOnly = await store.getRecent(10, 'alice');
    assert.equal(aliceOnly.length, 1);
    assert.equal(aliceOnly[0].content, 'alice msg');
  });

  it('getMentionsFor() returns messages mentioning a specific cat', async () => {
    const now = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'hi opus', mentions: ['opus'], timestamp: now });
    await store.append({ userId: 'u', catId: null, content: 'hi codex', mentions: ['codex'], timestamp: now + 1 });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'hi both',
      mentions: ['opus', 'codex'],
      timestamp: now + 2,
    });

    const opusMentions = await store.getMentionsFor('opus');
    assert.equal(opusMentions.length, 2);
    assert.equal(opusMentions[0].content, 'hi opus');
    assert.equal(opusMentions[1].content, 'hi both');
  });

  it('getMentionsFor() filters by threadId (#75)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tA',
      mentions: ['opus'],
      timestamp: now,
      threadId: 'thread-A',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tB',
      mentions: ['opus'],
      timestamp: now + 1,
      threadId: 'thread-B',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tA again',
      mentions: ['opus'],
      timestamp: now + 2,
      threadId: 'thread-A',
    });

    const threadA = await store.getMentionsFor('opus', 10, undefined, 'thread-A');
    assert.equal(threadA.length, 2);
    assert.equal(threadA[0].content, '@opus in tA');
    assert.equal(threadA[1].content, '@opus in tA again');

    // Without threadId returns all
    const all = await store.getMentionsFor('opus', 10);
    assert.equal(all.length, 3);
  });

  it('getBefore() returns messages before timestamp', async () => {
    const base = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'old', mentions: [], timestamp: base });
    await store.append({ userId: 'u', catId: null, content: 'mid', mentions: [], timestamp: base + 100 });
    await store.append({ userId: 'u', catId: null, content: 'new', mentions: [], timestamp: base + 200 });

    const before = await store.getBefore(base + 200, 10);
    assert.equal(before.length, 2);
    assert.equal(before[0].content, 'old');
    assert.equal(before[1].content, 'mid');
  });

  it('getBefore() respects limit', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.append({ userId: 'u', catId: null, content: `msg${i}`, mentions: [], timestamp: base + i });
    }

    const before = await store.getBefore(base + 5, 2);
    assert.equal(before.length, 2);
    // Should get the 2 most recent before the cursor
    assert.equal(before[0].content, 'msg3');
    assert.equal(before[1].content, 'msg4');
  });

  it('hardDelete clears toolEvents from returned object and Redis', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'tool msg',
      mentions: [],
      timestamp: Date.now(),
      toolEvents: [
        { id: 'te-1', type: 'tool_use', label: 'opus → read', timestamp: Date.now() },
        { id: 'te-2', type: 'tool_result', label: 'opus ← result', detail: 'ok', timestamp: Date.now() },
      ],
    });
    // Verify toolEvents were stored
    const before = await store.getById(msg.id);
    assert.equal(before.toolEvents.length, 2);

    // hardDelete should clear toolEvents
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.toolEvents, undefined, 'returned object should not carry toolEvents');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.toolEvents, undefined, 'Redis should not return toolEvents after hardDelete');
  });

  it('hardDelete clears thinking from returned object and Redis (F045 security)', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'response with thinking',
      mentions: [],
      timestamp: Date.now(),
      thinking: 'secret extended reasoning that must not survive hard delete',
    });
    // Verify thinking was stored
    const before = await store.getById(msg.id);
    assert.equal(before.thinking, 'secret extended reasoning that must not survive hard delete');

    // hardDelete should clear thinking
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.thinking, undefined, 'returned object should not carry thinking');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm thinking is gone
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.thinking, undefined, 'Redis should not return thinking after hardDelete');
  });

  it('message TTL is set', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: null,
      content: 'ttl test',
      mentions: [],
      timestamp: Date.now(),
    });
    const ttl = await redis.ttl(`msg:${msg.id}`);
    assert.ok(ttl > 0, `Expected positive TTL, got ${ttl}`);
    assert.ok(ttl <= 60, `Expected TTL <= 60, got ${ttl}`);
  });

  it('append() with same idempotencyKey returns existing message', async () => {
    const first = await store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    const second = await store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff retried',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    assert.equal(second.id, first.id);
    assert.equal(second.content, 'kickoff');

    const threadMessages = await store.getByThread('thread-idem', 10, 'u1');
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0].id, first.id);
  });

  it('F057-C2: mentionsUser round-trips through append/getById', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: '@铲屎官 看看这个',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-mention-user',
      mentionsUser: true,
    });
    assert.equal(msg.mentionsUser, true, 'append should return mentionsUser');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.mentionsUser, true, 'getById should deserialize mentionsUser');
  });

  it('F057-C2: mentionsUser round-trips through hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'u',
      catId: 'opus',
      content: '@user please check',
      mentions: [],
      timestamp: now,
      threadId: 'thread-mention-hydrate',
      mentionsUser: true,
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'normal message',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-mention-hydrate',
    });

    const msgs = await store.getByThread('thread-mention-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].mentionsUser, true, 'first message should have mentionsUser');
    assert.equal(msgs[1].mentionsUser, undefined, 'second message should not have mentionsUser');
  });

  it('getByThreadAfter() returns delivered messages whose score shifted forward (Bug A cursor regression)', async () => {
    const base = Date.now();
    const threadId = 'thread-cursor-deliver';

    // Simulate: msg1 sent at base, msg2 sent at base+1, msg3 (queued) sent at base+2
    const msg1 = await store.append({
      userId: 'u',
      catId: null,
      content: 'msg1',
      mentions: [],
      timestamp: base,
      threadId,
    });
    const msg2 = await store.append({
      userId: 'u',
      catId: null,
      content: 'msg2',
      mentions: [],
      timestamp: base + 1,
      threadId,
    });
    const msg3 = await store.append({
      userId: 'u',
      catId: null,
      content: 'msg3-queued',
      mentions: [],
      timestamp: base + 2,
      threadId,
    });

    // msg3 was queued and delivered later — its score shifts forward
    await store.markDelivered(msg3.id, base + 500);

    // Cursor is msg1 — should see msg2 AND msg3 (even though msg3's score shifted)
    const afterMsg1 = await store.getByThreadAfter(threadId, msg1.id);
    const ids = afterMsg1.map((m) => m.id);
    assert.ok(ids.includes(msg2.id), 'msg2 should appear after cursor msg1');
    assert.ok(ids.includes(msg3.id), 'msg3 (delivered later) should appear after cursor msg1');

    // Cursor is msg2 — should see msg3 (higher score after delivery)
    const afterMsg2 = await store.getByThreadAfter(threadId, msg2.id);
    const ids2 = afterMsg2.map((m) => m.id);
    assert.ok(ids2.includes(msg3.id), 'msg3 should appear after cursor msg2 despite score shift');
  });

  it('getByThreadAfter() does not skip same-score messages after deliveredAt shift', async () => {
    const base = Date.now();
    const threadId = 'thread-cursor-same-score';

    // msg1 sent at base, msg2 sent at base+1
    const msg1 = await store.append({
      userId: 'u',
      catId: null,
      content: 'early',
      mentions: [],
      timestamp: base,
      threadId,
    });
    const msg2 = await store.append({
      userId: 'u',
      catId: null,
      content: 'late-queued',
      mentions: [],
      timestamp: base + 1,
      threadId,
    });

    // Both delivered at the same deliveredAt time
    await store.markDelivered(msg1.id, base + 100);
    await store.markDelivered(msg2.id, base + 100);

    // Cursor is msg1 — msg2 has the same score but different ID, should still appear
    const afterMsg1 = await store.getByThreadAfter(threadId, msg1.id);
    const ids = afterMsg1.map((m) => m.id);
    assert.ok(ids.includes(msg2.id), 'msg2 with same deliveredAt score should appear via ID tiebreaker');
  });

  it('F148: origin=briefing survives append → getById round-trip', async () => {
    const msg = await store.append({
      userId: 'system',
      catId: null,
      content: 'briefing summary',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-briefing-rt',
      origin: 'briefing',
      extra: { rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1, title: 'test', tone: 'info' }] } },
    });
    assert.equal(msg.origin, 'briefing', 'append should return origin=briefing');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.origin, 'briefing', 'getById must deserialize origin=briefing');
    assert.ok(fetched.extra?.rich?.blocks?.length, 'rich blocks must survive round-trip');
  });

  it('F148: origin=briefing survives hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'system',
      catId: null,
      content: 'briefing card',
      mentions: [],
      timestamp: now,
      threadId: 'thread-briefing-hydrate',
      origin: 'briefing',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'normal',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-briefing-hydrate',
    });

    const msgs = await store.getByThread('thread-briefing-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].origin, 'briefing', 'briefing message must keep origin via hydrateMessages');
    assert.equal(msgs[1].origin, undefined, 'normal message should have no origin');
  });
});
