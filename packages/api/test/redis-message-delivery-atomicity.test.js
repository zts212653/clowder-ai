/**
 * Delivery-order transition atomicity tests (PR #1193).
 *
 * Bug: reassignUserId / markDelivered / markCanceled each read a JS snapshot
 * then write via independent MULTI/HSET — no shared atomic boundary. Two
 * concurrent writers can interleave and leave hash vs zset state inconsistent.
 *
 * Fix: single Lua script per transition (deliver / cancel / reassign) that
 * reads + writes inside Redis's single-threaded Lua executor.
 *
 * RED tests — written BEFORE the fix, expected to fail against base 128263c9b.
 * Deterministic failures: markCanceled-on-delivered guard (both stores).
 * Concurrent invariant tests: Promise.all with consistency assertions.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

/** Per-file unique keyPrefix isolates this suite from concurrent redis-message-store / f232 tests. */
const TEST_KEY_PREFIX = 'cat-cafe-dlv-atomicity:';

describe('delivery-order transition atomicity (PR #1193)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let MessageKeys;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'delivery-atomicity');

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
      console.warn('[delivery-atomicity] Redis unreachable, skipping');
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

    const expectedScore = String(msg.deliveredAt ?? msg.timestamp);
    const threadScore = await redis.zscore(MessageKeys.thread(msg.threadId), msgId);
    const timelineScore = await redis.zscore(MessageKeys.TIMELINE, msgId);
    const userScore = await redis.zscore(MessageKeys.user(msg.userId), msgId);

    assert.equal(threadScore, expectedScore, `${label}: thread zset score must match hash`);
    assert.equal(timelineScore, expectedScore, `${label}: timeline zset score must match hash`);
    assert.equal(userScore, expectedScore, `${label}: user zset score must match hash`);

    // User zset membership: msg must only be in its current owner's zset
    return msg;
  };

  // ── sol's 6 RED test cases ──

  // 1. reassign snapshot → delivery commit → reassign commit
  it('concurrent reassign+deliver: reassign reads stale → deliver writes → reassign overwrites stale score', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-rd-1';
    const msg = await createQueued('userA', threadId, base);

    // Run both concurrently — event loop interleaving creates the race window
    const [reassigned, delivered] = await Promise.all([
      store.reassignUserId(msg.id, 'userB'),
      store.markDelivered(msg.id, base + 500),
    ]);

    // Post-condition invariant: hash, thread, timeline, user zsets must all agree
    const canonical = await assertConsistency(msg.id, 'reassign+deliver');

    // Score must reflect deliveredAt if delivered, regardless of who owns it
    if (canonical.deliveryStatus === 'delivered') {
      const expectedScore = String(canonical.deliveredAt);
      const userKey = MessageKeys.user(canonical.userId);
      const userScore = await redis.zscore(userKey, msg.id);
      assert.equal(userScore, expectedScore, 'user zset score must equal deliveredAt after delivery');
    }
  });

  // 2. delivery snapshot → reassign commit → delivery retry (now: delivery commit)
  it('concurrent deliver+reassign: deliver reads stale userId → reassign writes → deliver writes to old user', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-dr-2';
    const msg = await createQueued('userA', threadId, base);

    // Reverse order from test 1
    const [delivered, reassigned] = await Promise.all([
      store.markDelivered(msg.id, base + 300),
      store.reassignUserId(msg.id, 'userC'),
    ]);

    const canonical = await assertConsistency(msg.id, 'deliver+reassign');

    // The old user (userA) must NOT have a dangling zset entry
    if (canonical.userId !== 'userA') {
      const oldUserScore = await redis.zscore(MessageKeys.user('userA'), msg.id);
      assert.equal(oldUserScore, null, 'old user must not have dangling zset entry after reassign');
    }
  });

  // 3. cancel vs deliver: exactly one CAS winner (applied-result contract)
  it('concurrent cancel+deliver on queued msg: exactly one transition wins, return values prove it', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-cd-3';
    const msg = await createQueued('userA', threadId, base);

    const [cancelResult, deliverResult] = await Promise.all([
      store.markCanceled(msg.id),
      store.markDelivered(msg.id, base + 100),
    ]);

    // Exactly one CAS transition must return non-null — the loser gets null
    const winners = [cancelResult, deliverResult].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one CAS transition must return non-null');

    // The non-null winner must match canonical delivery status
    const canonical = await store.getById(msg.id);
    assert.ok(
      canonical.deliveryStatus === 'delivered' || canonical.deliveryStatus === 'canceled',
      `status must be delivered or canceled, got: ${canonical.deliveryStatus}`,
    );

    if (cancelResult) {
      assert.equal(deliverResult, null, 'deliver must return null when cancel wins');
      assert.equal(canonical.deliveryStatus, 'canceled', 'cancel winner matches canonical state');
    } else {
      assert.equal(cancelResult, null, 'cancel must return null when deliver wins');
      assert.equal(canonical.deliveryStatus, 'delivered', 'deliver winner matches canonical state');
      assert.equal(canonical.deliveredAt, base + 100, 'deliveredAt matches the winning delivery');
    }

    // Zset consistency: delivered → scores updated; canceled → scores unchanged
    if (canonical.deliveryStatus === 'delivered') {
      await assertConsistency(msg.id, 'cancel-loses-to-deliver');
    } else {
      const threadScore = await redis.zscore(MessageKeys.thread(threadId), msg.id);
      assert.equal(threadScore, String(base), 'canceled msg score must be original timestamp');
    }
  });

  // 4. concurrent reassign A→B / A→C: exactly one final owner
  it('concurrent reassign to two targets: final state has single owner', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-rr-4';
    const msg = await createQueued('userA', threadId, base);
    // Deliver first so the score is stable
    await store.markDelivered(msg.id, base + 100);

    await Promise.all([store.reassignUserId(msg.id, 'userB'), store.reassignUserId(msg.id, 'userC')]);

    const canonical = await store.getById(msg.id);
    const winner = canonical.userId;
    assert.ok(winner === 'userB' || winner === 'userC', `winner must be userB or userC, got: ${winner}`);

    // Winner has the entry, losers don't
    const winnerScore = await redis.zscore(MessageKeys.user(winner), msg.id);
    assert.ok(winnerScore !== null, 'winner must have zset entry');

    const loser = winner === 'userB' ? 'userC' : 'userB';
    const loserScore = await redis.zscore(MessageKeys.user(loser), msg.id);
    assert.equal(loserScore, null, 'loser must not have zset entry');

    // Original user must not have entry either
    const origScore = await redis.zscore(MessageKeys.user('userA'), msg.id);
    assert.equal(origScore, null, 'original user must not have zset entry after reassign');
  });

  // 5. return values must reflect canonical post-state (not stale JS snapshot)
  it('return value of reassignUserId reflects canonical Redis state', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-ret-5';
    const msg = await createQueued('userA', threadId, base);

    // Deliver, then reassign
    await store.markDelivered(msg.id, base + 200);
    const reassigned = await store.reassignUserId(msg.id, 'userD');

    assert.equal(reassigned.userId, 'userD', 'returned msg must show new userId');
    assert.equal(reassigned.deliveryStatus, 'delivered', 'returned msg must preserve delivered status');
    assert.equal(reassigned.deliveredAt, base + 200, 'returned msg must preserve deliveredAt');
  });

  // 6. sequential delivery → reassign → startup backfill all stay green
  it('sequential deliver → reassign preserves score=deliveredAt in new user zset', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-seq-6';
    const msg = await createQueued('userA', threadId, base);

    // Sequential: deliver first, then reassign
    await store.markDelivered(msg.id, base + 400);
    await store.reassignUserId(msg.id, 'userE');

    const canonical = await store.getById(msg.id);
    assert.equal(canonical.userId, 'userE');
    assert.equal(canonical.deliveredAt, base + 400);

    // New user's zset score must be deliveredAt, not original timestamp
    const userScore = await redis.zscore(MessageKeys.user('userE'), msg.id);
    assert.equal(userScore, String(base + 400), 'new user zset score must be deliveredAt');

    // Old user must be cleaned
    const oldScore = await redis.zscore(MessageKeys.user('userA'), msg.id);
    assert.equal(oldScore, null, 'old user must not have entry');
  });

  // ── Supplementary test cases (guard/idempotency) ──

  // 7. markCanceled on delivered message → must be no-op (DETERMINISTIC RED)
  it('markCanceled on delivered message is no-op (guard: queued-only transition)', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-guard-7';
    const msg = await createQueued('userA', threadId, base);

    // Deliver first
    await store.markDelivered(msg.id, base + 100);

    // Cancel should be CAS no-op — returns null, delivered state survives
    const result = await store.markCanceled(msg.id);
    assert.equal(result, null, 'CAS no-op must return null (message already delivered)');

    const canonical = await store.getById(msg.id);
    assert.equal(canonical.deliveryStatus, 'delivered', 'markCanceled must NOT overwrite delivered status');
    assert.equal(canonical.deliveredAt, base + 100, 'deliveredAt must survive cancel attempt');
  });

  // 8. after concurrent ops, all three zset scores + hash are consistent
  it('concurrent deliver+reassign: thread/timeline/user zset scores all agree with hash', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-zset-8';
    // Run 5 rounds to increase chance of hitting the race
    for (let round = 0; round < 5; round++) {
      await cleanupClientKeyspace(redis);
      const msg = await createQueued('userA', threadId, base + round * 1000);

      await Promise.all([
        store.markDelivered(msg.id, base + round * 1000 + 500),
        store.reassignUserId(msg.id, `userR${round}`),
      ]);

      // Full consistency check — this is the core invariant
      await assertConsistency(msg.id, `round-${round}`);
    }
  });

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
    assert.equal(result, null, 'CAS no-op must return null (message not queued)');

    const canonical = await store.getById(msg.id);
    assert.notEqual(canonical.deliveryStatus, 'canceled', 'immediate message must not be marked canceled');
  });

  // 10. already-canceled: second markCanceled must return null (CAS idempotency)
  it('markCanceled on already-canceled message returns null (CAS idempotency)', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-idem-10';
    const msg = await createQueued('userA', threadId, base);

    // First cancel wins
    const first = await store.markCanceled(msg.id);
    assert.ok(first, 'first markCanceled must succeed (CAS applied)');
    assert.equal(first.deliveryStatus, 'canceled', 'first cancel must transition to canceled');

    // Second cancel is a no-op — CAS sees 'canceled' not 'queued'
    const second = await store.markCanceled(msg.id);
    assert.equal(second, null, 'second markCanceled must return null (already canceled)');
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
});

// ── In-memory MessageStore: markCanceled guard (deterministic RED) ──

describe('in-memory MessageStore markCanceled guard (PR #1193)', () => {
  let MessageStore;

  before(async () => {
    const mod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    MessageStore = mod.MessageStore;
  });

  it('markCanceled on delivered message is no-op (guard parity with Redis)', async () => {
    const memStore = new MessageStore();
    const base = Date.now();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: base,
      threadId: 'thread-mem-guard',
      deliveryStatus: 'queued',
    });

    memStore.markDelivered(msg.id, base + 100);

    // Cancel should be CAS no-op → null
    const result = memStore.markCanceled(msg.id);
    assert.equal(result, null, 'in-memory CAS no-op must return null');
    assert.equal(memStore.getById(msg.id).deliveryStatus, 'delivered', 'delivered status must survive cancel attempt');
  });

  it('markCanceled on immediate/no-status message is no-op', async () => {
    const memStore = new MessageStore();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'immediate',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-mem-imm',
    });

    const result = memStore.markCanceled(msg.id);
    assert.equal(result, null, 'in-memory CAS no-op must return null (not queued)');
    assert.notEqual(memStore.getById(msg.id).deliveryStatus, 'canceled', 'immediate message must not become canceled');
  });

  it('markCanceled on already-canceled message returns null (CAS idempotency parity)', async () => {
    const memStore = new MessageStore();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-mem-idem',
      deliveryStatus: 'queued',
    });

    const first = memStore.markCanceled(msg.id);
    assert.ok(first, 'first cancel must succeed');
    assert.equal(first.deliveryStatus, 'canceled');

    const second = memStore.markCanceled(msg.id);
    assert.equal(second, null, 'second cancel must return null (already canceled)');
  });
});
