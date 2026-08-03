/**
 * Redis delivery transition contract tests (PR #1193).
 *
 * Bug: reassignUserId / markDelivered / markCanceled each read a JS snapshot
 * then write via independent MULTI/HSET — no shared atomic boundary. Two
 * concurrent writers can interleave and leave hash vs zset state inconsistent.
 *
 * Fix: single Lua script per transition (deliver / cancel / reassign) that
 * reads + writes inside Redis's single-threaded Lua executor.
 *
 * The regression suite was observed RED against pre-intake Clowder AI main.
 * Supplementary coverage: CAS idempotency, Lua receipts, TTL, custody publication,
 * and legacy/repaired reassignment ordering.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { makeQueuedMessageCustody as makeCustody } from './helpers/queued-message-custody.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

/** Per-file unique keyPrefix isolates this suite from concurrent redis-message-store / f232 tests. */
const TEST_KEY_PREFIX = 'cat-cafe-dlv-contracts:';

describe('Redis delivery transition contracts (PR #1193)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let MessageKeys;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'delivery-contracts');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = storeModule.RedisMessageStore;
    const keysModule = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js');
    MessageKeys = keysModule.MessageKeys;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[delivery-contracts] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  // ── Helper: create a queued message for testing ──
  const createQueued = (userId, threadId, ts) =>
    store.append({
      userId,
      catId: null,
      content: `queued-msg-${ts}`,
      mentions: [],
      timestamp: ts,
      threadId,
      deliveryStatus: 'queued',
    });

  // ── Helper: assert hash/zset consistency invariant ──
  const assertConsistency = async (msgId, label) => {
    const msg = await store.getById(msgId);
    assert.ok(msg, `${label}: message must exist`);

    const expectedScore = String(msg.timelineOrderAt ?? msg.deliveredAt ?? msg.timestamp);
    const threadScore = await redis.zscore(MessageKeys.thread(msg.threadId), msgId);
    const timelineScore = await redis.zscore(MessageKeys.TIMELINE, msgId);
    const userScore = await redis.zscore(MessageKeys.user(msg.userId), msgId);

    assert.equal(threadScore, expectedScore, `${label}: thread zset score must match hash`);
    assert.equal(timelineScore, expectedScore, `${label}: timeline zset score must match hash`);
    assert.equal(userScore, expectedScore, `${label}: user zset score must match hash`);

    // User zset membership: msg must only be in its current owner's zset
    return msg;
  };

  // ── Delivery contract and compatibility cases ──

  // 9. regression: no caller depends on cancel-non-queued behavior (F117 withdraw)
  it('markCanceled on immediate/no-status message is no-op', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-imm-9';
    // Create a message WITHOUT deliveryStatus (= immediate/legacy)
    const msg = await store.append({
      userId: 'userA',
      catId: null,
      content: 'immediate msg',
      mentions: [],
      timestamp: base,
      threadId,
    });

    const result = await store.markCanceled(msg.id);
    assert.equal(result?.deliveryTransitioned, false, 'CAS no-op must report applied=false');

    const canonical = await store.getById(msg.id);
    assert.notEqual(canonical.deliveryStatus, 'canceled', 'immediate message must not be marked canceled');
  });

  // 10. already-canceled: second markCanceled reports a CAS no-op.
  it('markCanceled on already-canceled message reports applied=false (CAS idempotency)', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-idem-10';
    const msg = await createQueued('userA', threadId, base);

    // First cancel wins
    const first = await store.markCanceled(msg.id);
    assert.ok(first, 'first markCanceled must succeed (CAS applied)');
    assert.equal(first.deliveryStatus, 'canceled', 'first cancel must transition to canceled');

    // Second cancel is a no-op — CAS sees 'canceled' not 'queued'.
    const second = await store.markCanceled(msg.id);
    assert.equal(second?.deliveryTransitioned, false, 'second markCanceled must report applied=false');
  });

  // 11. CAS receipt survives without getById (Lua-side HGETALL hydration regression)
  it('markDelivered returns complete StoredMessage from Lua (no getById gap)', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-receipt-11';
    const msg = await createQueued('userA', threadId, base);

    // Monkey-patch getById to throw — proves CAS winner is hydrated from Lua, not getById
    const origGetById = store.getById.bind(store);
    store.getById = () => {
      throw new Error('getById must not be called for CAS-win hydration');
    };

    try {
      const delivered = await store.markDelivered(msg.id, base + 777);

      assert.ok(delivered, 'CAS winner must return non-null');
      assert.equal(delivered.deliveryTransitioned, true, 'delivery receipt must report applied=true');
      assert.equal(delivered.id, msg.id, 'id must match');
      assert.equal(delivered.userId, 'userA', 'userId must be hydrated');
      assert.equal(delivered.threadId, threadId, 'threadId must be hydrated');
      assert.equal(delivered.deliveryStatus, 'delivered', 'status must be delivered');
      assert.equal(delivered.deliveredAt, base + 777, 'deliveredAt must be hydrated');
      assert.equal(delivered.content, `queued-msg-${base}`, 'content must be hydrated');
      assert.equal(delivered.timestamp, base, 'timestamp must be hydrated');
    } finally {
      store.getById = origGetById;
    }
  });

  // 12. Analogous cancel path: CAS receipt without getById
  it('markCanceled returns complete StoredMessage from Lua (no getById gap)', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-receipt-12';
    const msg = await createQueued('userA', threadId, base);

    const origGetById = store.getById.bind(store);
    store.getById = () => {
      throw new Error('getById must not be called for CAS-win hydration');
    };

    try {
      const canceled = await store.markCanceled(msg.id);

      assert.ok(canceled, 'CAS winner must return non-null');
      assert.equal(canceled.deliveryTransitioned, true, 'cancellation receipt must report applied=true');
      assert.equal(canceled.id, msg.id, 'id must match');
      assert.equal(canceled.deliveryStatus, 'canceled', 'status must be canceled');
      assert.equal(canceled.userId, 'userA', 'userId must be hydrated');
      assert.equal(canceled.threadId, threadId, 'threadId must be hydrated');
      assert.equal(canceled.timestamp, base, 'timestamp must be hydrated');
    } finally {
      store.getById = origGetById;
    }
  });

  // 13. TTL branch: reassign with ttlSeconds > 0 applies EXPIRE inside Lua
  it('reassignUserId with positive TTL sets EXPIRE on new user zset key', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-ttl-13';

    // Create a store WITH ttlSeconds to exercise the EXPIRE branch
    const ttlStore = new RedisMessageStore(redis, { ttlSeconds: 60 });
    const msg = await ttlStore.append({
      userId: 'userA',
      catId: null,
      content: 'ttl-test-msg',
      mentions: [],
      timestamp: base,
      threadId,
      deliveryStatus: 'queued',
    });
    await ttlStore.markDelivered(msg.id, base + 100);

    // Reassign to userF — EXPIRE should fire inside Lua
    const reassigned = await ttlStore.reassignUserId(msg.id, 'userF');
    assert.ok(reassigned, 'reassign must succeed');
    assert.equal(reassigned.userId, 'userF');

    // Verify the new user zset key has a positive TTL
    const ttl = await redis.ttl(MessageKeys.user('userF'));
    assert.ok(ttl > 0 && ttl <= 60, `new user zset key must have TTL (got ${ttl}s)`);

    // Old user key should NOT have the message
    const oldScore = await redis.zscore(MessageKeys.user('userA'), msg.id);
    assert.equal(oldScore, null, 'old user must not have entry');
  });

  // 14. Terminal custody is completed execution history, not an active delivery fence.
  it('markDelivered publishes a queued message whose custody is already terminal', async () => {
    const base = Date.now();
    const terminalCustody = makeCustody({
      status: 'terminal',
      pendingTargetCats: [],
      failedByCatIds: ['opus', 'codex'],
      updatedAt: base,
    });
    const msg = await store.append({
      userId: 'userA',
      catId: null,
      content: 'terminal custody is publishable',
      mentions: ['opus', 'codex'],
      timestamp: base,
      threadId: 'thread-dlv-terminal-custody-14',
      deliveryStatus: 'queued',
      queueCustody: terminalCustody,
    });

    const result = await store.markDelivered(msg.id, base + 100);

    assert.equal(result?.deliveryTransitioned, true, 'terminal custody must not block the delivery transition');
    assert.equal(result?.deliveryStatus, 'delivered');
    assert.equal(result?.deliveredAt, base + 100);
    assert.equal(result?.timelineOrderAt, base, 'custody-backed receipt must retain its authored timeline position');
    assert.deepEqual(result?.queueCustody, terminalCustody, 'terminal custody history must remain attached');
    assert.equal(
      await redis.zscore(MessageKeys.thread(msg.threadId), msg.id),
      String(base),
      'thread receipt order must remain at author time',
    );
    assert.equal(
      await redis.zscore(MessageKeys.TIMELINE, msg.id),
      String(base),
      'global receipt order must remain at author time',
    );
    assert.equal(
      await redis.zscore(MessageKeys.user(msg.userId), msg.id),
      String(base),
      'owner receipt order must remain at author time',
    );
    await assertConsistency(msg.id, 'terminal-custody-delivery');
  });

  // 15. Legacy/repaired rows may have a canonical zset score without a hash projection.
  it('reassignUserId preserves the source user zset score when timelineOrderAt is absent', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-repaired-score-15';
    const msg = await createQueued('userA', threadId, base);
    await store.markDelivered(msg.id, base + 500);

    const repairedScore = base + 200;
    await redis.hdel(MessageKeys.detail(msg.id), 'timelineOrderAt');
    await redis.zadd(MessageKeys.thread(threadId), repairedScore, msg.id);
    await redis.zadd(MessageKeys.TIMELINE, repairedScore, msg.id);
    await redis.zadd(MessageKeys.user('userA'), repairedScore, msg.id);

    const reassigned = await store.reassignUserId(msg.id, 'userB');

    assert.equal(reassigned?.userId, 'userB');
    assert.equal(reassigned?.timelineOrderAt, undefined, 'reassignment must not invent a missing hash projection');
    assert.equal(await redis.zscore(MessageKeys.user('userA'), msg.id), null, 'old owner membership must be removed');
    assert.equal(
      await redis.zscore(MessageKeys.user('userB'), msg.id),
      String(repairedScore),
      'new owner membership must preserve the canonical source zset score',
    );
    assert.equal(await redis.zscore(MessageKeys.thread(threadId), msg.id), String(repairedScore));
    assert.equal(await redis.zscore(MessageKeys.TIMELINE, msg.id), String(repairedScore));
  });
});
