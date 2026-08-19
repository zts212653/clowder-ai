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
 * The regression suite was observed RED against pre-intake Clowder AI main.
 * Deterministic failures: Redis markCanceled-on-delivered guard.
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

  // ── Atomic race cases ──

  // 1. reassign snapshot → delivery commit → reassign commit
  it('concurrent reassign+deliver: reassign reads stale → deliver writes → reassign overwrites stale score', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-rd-1';
    const msg = await createQueued('userA', threadId, base);

    // Run both concurrently — event loop interleaving creates the race window
    await Promise.all([store.reassignUserId(msg.id, 'userB'), store.markDelivered(msg.id, base + 500)]);

    // Post-condition invariant: hash, thread, timeline, user zsets must all agree
    const canonical = await assertConsistency(msg.id, 'reassign+deliver');

    // Score must reflect the canonical publication order, regardless of owner.
    if (canonical.deliveryStatus === 'delivered') {
      const expectedScore = String(canonical.timelineOrderAt ?? canonical.deliveredAt);
      const userKey = MessageKeys.user(canonical.userId);
      const userScore = await redis.zscore(userKey, msg.id);
      assert.equal(userScore, expectedScore, 'user zset score must equal canonical publication order');
    }
  });

  // 2. delivery snapshot → reassign commit → delivery retry (now: delivery commit)
  it('concurrent deliver+reassign: deliver reads stale userId → reassign writes → deliver writes to old user', async () => {
    const base = Date.now();
    const threadId = 'thread-dlv-dr-2';
    const msg = await createQueued('userA', threadId, base);

    // Reverse order from test 1
    await Promise.all([store.markDelivered(msg.id, base + 300), store.reassignUserId(msg.id, 'userC')]);

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

    // Exactly one transition reports that it applied; the loser returns canonical state with applied=false.
    const winners = [cancelResult, deliverResult].filter((result) => result?.deliveryTransitioned === true);
    assert.equal(winners.length, 1, 'exactly one CAS transition must report applied=true');

    // The applied winner must match canonical delivery status.
    const canonical = await store.getById(msg.id);
    assert.ok(
      canonical.deliveryStatus === 'delivered' || canonical.deliveryStatus === 'canceled',
      `status must be delivered or canceled, got: ${canonical.deliveryStatus}`,
    );

    if (cancelResult?.deliveryTransitioned === true) {
      assert.equal(deliverResult?.deliveryTransitioned, false, 'deliver must report applied=false when cancel wins');
      assert.equal(canonical.deliveryStatus, 'canceled', 'cancel winner matches canonical state');
    } else {
      assert.equal(cancelResult?.deliveryTransitioned, false, 'cancel must report applied=false when deliver wins');
      assert.equal(deliverResult?.deliveryTransitioned, true, 'delivery must be the applied winner');
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

    // Cancel should be a CAS no-op — applied=false and delivered state survives.
    const result = await store.markCanceled(msg.id);
    assert.equal(result?.deliveryTransitioned, false, 'CAS no-op must report applied=false');

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
});
