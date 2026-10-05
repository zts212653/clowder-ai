/**
 * F167 #1449 Slice 2 — RedisHoldQuotaStore: shared hold quota authority.
 *
 * Validates the Redis-backed implementation of IHoldQuotaStore:
 * - Atomic admission via Lua script (serialized by Redis single-threaded executor)
 * - True sliding window: events expire individually
 * - Shared authority: two independent RedisHoldQuotaStore clients see the same quota
 * - Process replacement: rebuilding the client does not reset quota
 * - Pair fence: releaseByEventId cannot cross (threadId, catId) boundaries
 * - A/B interleaving: compensation targets only the correct reservation
 * - Concurrent admission barrier: two clients, one slot, exactly one wins
 *
 * Runs via: pnpm --filter @cat-cafe/api test:redis
 * Requires isolated Redis (CAT_CAFE_REDIS_TEST_ISOLATED=1).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const WINDOW_MS = 3_600_000; // 1 hour
const MAX_HOLDS = 3;
const KEY_PATTERNS = ['hold-quota:*'];

describe(
  'RedisHoldQuotaStore — shared authority (#1449 Slice 2)',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let RedisHoldQuotaStore;
    let createRedisClient;
    let redis;
    let store;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisHoldQuotaStore');

      const storeModule = await import('../dist/domains/ball-custody/hold-quota-store-redis.js');
      RedisHoldQuotaStore = storeModule.RedisHoldQuotaStore;

      const redisModule = await import('@cat-cafe/shared/utils');
      createRedisClient = redisModule.createRedisClient;

      redis = createRedisClient({ url: REDIS_URL });
      await redis.ping();
      store = new RedisHoldQuotaStore(redis);
    });

    after(async () => {
      if (redis) {
        await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
        await redis.quit();
      }
    });

    // ─── Basic counting via tryAdmit ───

    it('getCount returns 0 for unseen (threadId, catId)', async () => {
      assert.equal(await store.getCount('t-new-redis', 'cat-new', WINDOW_MS), 0);
    });

    it('tryAdmit climbs 1→2→3 within window', async () => {
      const base = 2_000_000_000;
      const r1 = await store.tryAdmit('t1-redis', 'cat-a', MAX_HOLDS, WINDOW_MS, base);
      assert.equal(r1.admitted, true);
      assert.equal(r1.count, 1);
      assert.ok(typeof r1.eventId === 'string' && r1.eventId.length > 0, 'admitted must include UUID eventId');

      const r2 = await store.tryAdmit('t1-redis', 'cat-a', MAX_HOLDS, WINDOW_MS, base + 1_000);
      assert.equal(r2.admitted, true);
      assert.equal(r2.count, 2);

      const r3 = await store.tryAdmit('t1-redis', 'cat-a', MAX_HOLDS, WINDOW_MS, base + 2_000);
      assert.equal(r3.admitted, true);
      assert.equal(r3.count, 3);

      assert.equal(await store.getCount('t1-redis', 'cat-a', WINDOW_MS, base + 3_000), 3);
    });

    it('distinct (threadId, catId) pairs are independent', async () => {
      const base = 2_000_100_000;
      await store.tryAdmit('tA-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('tA-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 100);
      await store.tryAdmit('tB-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 200);
      assert.equal(await store.getCount('tA-redis', 'cat-x', WINDOW_MS, base + 300), 2);
      assert.equal(await store.getCount('tB-redis', 'cat-x', WINDOW_MS, base + 300), 1);
      assert.equal(await store.getCount('tA-redis', 'cat-y', WINDOW_MS, base + 300), 0);
    });

    // ─── TRUE SLIDING WINDOW ───

    it('true sliding window: hold at T=0, T=50min, T=100min — third is admitted', async () => {
      const T0 = 2_000_200_000;
      const T50 = T0 + 50 * 60_000;
      const T100 = T0 + 100 * 60_000;

      await store.tryAdmit('t-slide-redis', 'cat-s', MAX_HOLDS, WINDOW_MS, T0);
      await store.tryAdmit('t-slide-redis', 'cat-s', MAX_HOLDS, WINDOW_MS, T50);

      const countAtT100 = await store.getCount('t-slide-redis', 'cat-s', WINDOW_MS, T100);
      assert.equal(countAtT100, 1, 'only T=50min is in the 1h window at T=100min');

      const r3 = await store.tryAdmit('t-slide-redis', 'cat-s', MAX_HOLDS, WINDOW_MS, T100);
      assert.equal(r3.admitted, true, 'third hold admitted — true sliding window');
      assert.equal(r3.count, 2);
    });

    it('burst of 3 rapid holds blocks 4th', async () => {
      const base = 2_000_300_000;
      await store.tryAdmit('t-burst-redis', 'cat-b', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-burst-redis', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 1_000);
      await store.tryAdmit('t-burst-redis', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 2_000);

      const r4 = await store.tryAdmit('t-burst-redis', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 3_000);
      assert.equal(r4.admitted, false, '4th hold rejected');
      assert.equal(r4.count, MAX_HOLDS);
      assert.ok(r4.retryAtMs !== undefined, 'retryAtMs set on rejection');
    });

    // ─── retryAt accuracy ───

    it('tryAdmit rejection retryAt points to oldest event + windowMs', async () => {
      const base = 2_000_400_000;
      await store.tryAdmit('t-retry-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-retry-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 10_000);
      await store.tryAdmit('t-retry-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 20_000);

      const r4 = await store.tryAdmit('t-retry-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 30_000);
      assert.equal(r4.admitted, false);
      assert.equal(r4.retryAtMs, base + WINDOW_MS);
    });

    it('retryAt boundary: rejected 1ms before, admitted at retryAt', async () => {
      const base = 2_000_500_000;
      await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 5_000);
      await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 10_000);

      const r4 = await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 15_000);
      assert.equal(r4.admitted, false);
      const retryAt = r4.retryAtMs;
      assert.ok(retryAt !== undefined);

      // 1ms before: still rejected (event at base still in window)
      const rBefore = await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, retryAt - 1);
      assert.equal(rBefore.admitted, false, 'still rejected 1ms before retryAt');

      // At retryAt: admitted (event at base just expired)
      const rAt = await store.tryAdmit('t-exact-redis', 'cat-e', MAX_HOLDS, WINDOW_MS, retryAt);
      assert.equal(rAt.admitted, true, 'admitted at exactly retryAt');
    });

    // ─── Shared authority (Astra ruling: process replacement must NOT reset quota) ───

    it('shared authority: two independent clients see the same quota', async () => {
      const redis2 = createRedisClient({ url: REDIS_URL });
      await redis2.ping();
      const store2 = new RedisHoldQuotaStore(redis2);

      try {
        const base = 2_000_600_000;
        await store.tryAdmit('t-shared', 'cat-s', MAX_HOLDS, WINDOW_MS, base);
        await store.tryAdmit('t-shared', 'cat-s', MAX_HOLDS, WINDOW_MS, base + 1_000);

        // Second client sees the same count
        assert.equal(
          await store2.getCount('t-shared', 'cat-s', WINDOW_MS, base + 2_000),
          2,
          'second client sees quota written by first client',
        );

        // Second client can fill to max
        const r3 = await store2.tryAdmit('t-shared', 'cat-s', MAX_HOLDS, WINDOW_MS, base + 2_000);
        assert.equal(r3.admitted, true);
        assert.equal(r3.count, 3);

        // First client is now blocked
        const r4 = await store.tryAdmit('t-shared', 'cat-s', MAX_HOLDS, WINDOW_MS, base + 3_000);
        assert.equal(r4.admitted, false, 'first client blocked — shared quota authority');
      } finally {
        await redis2.quit();
      }
    });

    it('process replacement: rebuilding client does not reset quota', async () => {
      const base = 2_000_700_000;
      await store.tryAdmit('t-rebuild', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-rebuild', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 1_000);

      // Simulate process replacement: create a fresh Redis client + store
      const redis2 = createRedisClient({ url: REDIS_URL });
      await redis2.ping();
      const store2 = new RedisHoldQuotaStore(redis2);

      try {
        // New store sees the prior reservations (not reset)
        assert.equal(
          await store2.getCount('t-rebuild', 'cat-r', WINDOW_MS, base + 2_000),
          2,
          'rebuilt client sees prior quota — not reset',
        );

        // Can continue from where the old process left off
        const r3 = await store2.tryAdmit('t-rebuild', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000);
        assert.equal(r3.admitted, true);
        assert.equal(r3.count, 3);

        // 4th is blocked even from the rebuilt store
        const r4 = await store2.tryAdmit('t-rebuild', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 3_000);
        assert.equal(r4.admitted, false, 'rebuilt client respects prior quota');
      } finally {
        await redis2.quit();
      }
    });

    // ─── Reservation compensation (releaseByEventId) ───

    it('releaseByEventId deletes the exact event', async () => {
      const base = 2_000_800_000;
      await store.tryAdmit('t-rel-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
      const r2 = await store.tryAdmit('t-rel-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 1_000);
      await store.tryAdmit('t-rel-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000);
      assert.equal(await store.getCount('t-rel-redis', 'cat-r', WINDOW_MS, base + 3_000), 3);

      const released = await store.releaseByEventId(r2.eventId, 't-rel-redis', 'cat-r');
      assert.equal(released, true);
      assert.equal(await store.getCount('t-rel-redis', 'cat-r', WINDOW_MS, base + 3_000), 2);

      const r4 = await store.tryAdmit('t-rel-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 4_000);
      assert.equal(r4.admitted, true);
      assert.equal(r4.count, 3);
    });

    it('releaseByEventId returns false for non-existent eventId', async () => {
      const released = await store.releaseByEventId('nonexistent-uuid', 't-nope-redis', 'cat-nope');
      assert.equal(released, false);
    });

    it('releaseByEventId pair-fence: wrong key cannot delete (structural)', async () => {
      const base = 2_000_900_000;
      const r1 = await store.tryAdmit('t-a-redis', 'cat-1', MAX_HOLDS, WINDOW_MS, base);
      assert.ok(r1.eventId);

      // Wrong threadId: different sorted set key → ZREM on wrong key = 0
      const wrongThread = await store.releaseByEventId(r1.eventId, 't-b-redis', 'cat-1');
      assert.equal(wrongThread, false, 'wrong threadId cannot delete');
      assert.equal(await store.getCount('t-a-redis', 'cat-1', WINDOW_MS, base + 100), 1);

      // Wrong catId: different sorted set key → ZREM on wrong key = 0
      const wrongCat = await store.releaseByEventId(r1.eventId, 't-a-redis', 'cat-2');
      assert.equal(wrongCat, false, 'wrong catId cannot delete');
      assert.equal(await store.getCount('t-a-redis', 'cat-1', WINDOW_MS, base + 100), 1);

      // Correct pair succeeds
      const correct = await store.releaseByEventId(r1.eventId, 't-a-redis', 'cat-1');
      assert.equal(correct, true);
      assert.equal(await store.getCount('t-a-redis', 'cat-1', WINDOW_MS, base + 100), 0);
    });

    it('A/B interleaving: A compensation does not delete B reservation', async () => {
      const base = 2_001_000_000;

      await store.tryAdmit('t-ab-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base);

      const admitA = await store.tryAdmit('t-ab-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 200);
      assert.equal(admitA.admitted, true);
      assert.ok(admitA.eventId);

      const admitB = await store.tryAdmit('t-ab-redis', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 300);
      assert.equal(admitB.admitted, true);
      assert.ok(admitB.eventId);
      assert.notEqual(admitA.eventId, admitB.eventId, 'distinct UUID eventIds');

      assert.equal(await store.getCount('t-ab-redis', 'cat-x', WINDOW_MS, base + 400), 3);

      // A fails → compensate only A
      await store.releaseByEventId(admitA.eventId, 't-ab-redis', 'cat-x');

      assert.equal(
        await store.getCount('t-ab-redis', 'cat-x', WINDOW_MS, base + 400),
        2,
        'must be 2: baseline + B. A compensated, B untouched.',
      );

      // Double-release of A is no-op
      const secondRelease = await store.releaseByEventId(admitA.eventId, 't-ab-redis', 'cat-x');
      assert.equal(secondRelease, false, 'double release must be no-op');
    });

    // ─── Authority clock (P1 review finding: clock skew must not bypass quota) ───

    it('authority clock: two clients without explicit now cannot exceed quota', async () => {
      // Production path: no explicit `now` → Lua uses redis.call('TIME')
      // Both clients share the same Redis → same authority clock → no skew bypass
      const redis2 = createRedisClient({ url: REDIS_URL });
      await redis2.ping();
      const store2 = new RedisHoldQuotaStore(redis2);

      try {
        // Client A fills all 3 slots (no explicit now → Redis TIME)
        const r1 = await store.tryAdmit('t-authclock', 'cat-a', MAX_HOLDS, WINDOW_MS);
        assert.equal(r1.admitted, true);
        const r2 = await store.tryAdmit('t-authclock', 'cat-a', MAX_HOLDS, WINDOW_MS);
        assert.equal(r2.admitted, true);
        const r3 = await store.tryAdmit('t-authclock', 'cat-a', MAX_HOLDS, WINDOW_MS);
        assert.equal(r3.admitted, true);

        // Client B (different API node) cannot exceed quota — Redis TIME prevents skew bypass
        const r4 = await store2.tryAdmit('t-authclock', 'cat-a', MAX_HOLDS, WINDOW_MS);
        assert.equal(r4.admitted, false, 'fourth hold rejected — authority clock prevents skew bypass');
        assert.equal(r4.count, MAX_HOLDS);
      } finally {
        await redis2.quit();
      }
    });

    // ─── TTL (P2 review finding: keys must not grow unboundedly) ───

    it('quota key has positive TTL after admission', async () => {
      const base = 2_001_200_000;
      await store.tryAdmit('t-ttl-admit', 'cat-t', MAX_HOLDS, WINDOW_MS, base);

      // ioredis auto-prefixes the key argument for pttl
      const ttl = await redis.pttl('hold-quota:t-ttl-admit:cat-t');
      assert.ok(ttl > 0, `key must have positive TTL, got ${ttl}`);
      assert.ok(ttl <= WINDOW_MS * 2, `TTL must be ≤ windowMs × 2, got ${ttl}`);
    });

    it('quota key has positive TTL after rejection', async () => {
      const base = 2_001_300_000;
      await store.tryAdmit('t-ttl-rej', 'cat-t', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-ttl-rej', 'cat-t', MAX_HOLDS, WINDOW_MS, base + 1_000);
      await store.tryAdmit('t-ttl-rej', 'cat-t', MAX_HOLDS, WINDOW_MS, base + 2_000);

      // 4th is rejected
      const r4 = await store.tryAdmit('t-ttl-rej', 'cat-t', MAX_HOLDS, WINDOW_MS, base + 3_000);
      assert.equal(r4.admitted, false);

      const ttl = await redis.pttl('hold-quota:t-ttl-rej:cat-t');
      assert.ok(ttl > 0, `key must have positive TTL after rejection, got ${ttl}`);
    });

    // ─── retryAfterMs same-clock-domain (P1 review finding: Sol R6) ───

    it('retryAfterMs is computed from the same authority clock as retryAtMs', async () => {
      // Deterministic: explicit `now` simulates Redis TIME authority clock.
      // retryAfterMs must equal retryAtMs - now, proving both come from
      // the same clock domain — route handler never subtracts Date.now().
      const base = 2_002_000_000;
      const now = base + 500_000; // 500s after first hold

      await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base);
      await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base + 100_000);
      await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base + 200_000);

      // 4th attempt rejected at now=base+500_000
      const r4 = await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, now);
      assert.equal(r4.admitted, false);
      assert.ok(r4.retryAtMs > 0, 'retryAtMs must be set on rejection');

      // The critical assertion: retryAfterMs === retryAtMs - now
      // Both computed inside the same Lua script from the same `now` value.
      const expectedRetryAfterMs = r4.retryAtMs - now;
      assert.equal(
        r4.retryAfterMs,
        expectedRetryAfterMs,
        `retryAfterMs must equal retryAtMs - now (same clock domain): ` +
          `got ${r4.retryAfterMs}, expected ${expectedRetryAfterMs}`,
      );
      assert.ok(r4.retryAfterMs > 0, 'retryAfterMs must be positive when still within window');
    });

    it('retryAfterMs is 0 when admitted', async () => {
      const base = 2_002_100_000;
      const r1 = await store.tryAdmit('t-retryafter-admit', 'cat-ra', MAX_HOLDS, WINDOW_MS, base);
      assert.equal(r1.admitted, true);
      // Admitted results should not carry a retryAfterMs (or it should be 0/undefined)
      // Our Lua returns 0 for admitted; TypeScript does not set it on the admitted path.
      assert.equal(r1.retryAfterMs, undefined, 'admitted result has no retryAfterMs');
    });

    // ─── Concurrent admission barrier ───

    it('concurrent: two clients, one slot, exactly one admitted', async () => {
      const redis2 = createRedisClient({ url: REDIS_URL });
      await redis2.ping();
      const store2 = new RedisHoldQuotaStore(redis2);

      try {
        const base = 2_001_100_000;
        // Fill to MAX_HOLDS - 1
        await store.tryAdmit('t-race-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
        await store.tryAdmit('t-race-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 1_000);

        // Both try to grab the last slot concurrently
        const [rA, rB] = await Promise.all([
          store.tryAdmit('t-race-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000),
          store2.tryAdmit('t-race-redis', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000),
        ]);

        // Exactly one should be admitted (Lua script serializes atomically)
        const admittedCount = [rA, rB].filter((r) => r.admitted).length;
        assert.equal(admittedCount, 1, 'exactly one of two concurrent clients admitted');

        assert.equal(await store.getCount('t-race-redis', 'cat-r', WINDOW_MS, base + 3_000), MAX_HOLDS);
      } finally {
        await redis2.quit();
      }
    });
  },
);
