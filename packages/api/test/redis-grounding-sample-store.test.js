/**
 * F167 Phase O PR-O5: Redis-backed GroundingSampleStore Tests
 *
 * Verifies that grounding samples survive process restart by persisting to Redis.
 * 8-day TTL (operator directive) avoids race with weekly eval cron.
 *
 * Redis-backed (not in-memory): feedback_inmemory_store_tests_miss_redis_behavior.
 * Runs only under `pnpm --filter @cat-cafe/api test:redis`.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

/** @returns {import('../dist/infrastructure/grounding/types.js').ClaimGroundingEvent} */
function makeEvent(overrides = {}) {
  return {
    invocationId: 'inv-1',
    catId: 'opus',
    threadId: 'thread-1',
    claimType: 'object',
    sourceKind: 'self',
    sourceRef: { kind: 'pr_url', value: 'org/repo#1' },
    resolver: 'github_pr',
    resolverSourceTier: 'T1',
    cacheHit: false,
    verdict: 'verified',
    actionFamily: 'register_tracking',
    actionRisk: 'register_tracking',
    tool: 'register_pr_tracking',
    ts: Date.now(),
    resolverCallsRemaining: 5,
    ...overrides,
  };
}

describe('RedisGroundingSampleStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisGroundingSampleStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const TEST_KEY_PREFIX = 'f167-grounding-test:';

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisGroundingSampleStore');
    const mod = await import('../dist/infrastructure/grounding/redis-grounding-sample-store.js');
    RedisGroundingSampleStore = mod.RedisGroundingSampleStore;
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    store = new RedisGroundingSampleStore(redis);
  });

  // ── Core persistence ───────────────────────────────────────

  it('stores and retrieves mismatch events', async () => {
    await store.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-m1' }), false);
    await store.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-m2' }), false);
    const samples = await store.getSamples();
    assert.equal(samples.length, 2);
    assert.equal(samples[0].invocationId, 'inv-m1');
    assert.equal(samples[1].invocationId, 'inv-m2');
  });

  it('survives simulated restart (new store instance, same Redis)', async () => {
    await store.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-persist' }), false);

    // "Restart": new store instance pointing to same Redis
    const store2 = new RedisGroundingSampleStore(redis);
    const samples = await store2.getSamples();
    assert.equal(samples.length, 1);
    assert.equal(samples[0].invocationId, 'inv-persist');
  });

  // ── wouldBlock: 100% keep ─────────────────────────────────

  it('wouldBlock events always stored regardless of verdict', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record(makeEvent({ verdict: 'insufficient', invocationId: `inv-wb-${i}` }), true);
    }
    const samples = await store.getSamples();
    assert.equal(samples.length, 5);
  });

  // ── Insufficient: cap 3 per resolver×thread×day ───────────

  it('insufficient events capped at 3 per resolver×thread×day', async () => {
    const baseTs = new Date('2026-06-20T00:00:00Z').getTime();
    for (let i = 0; i < 10; i++) {
      await store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'github_pr',
          threadId: 'thread-A',
          invocationId: `inv-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
    }
    const samples = (await store.getSamples()).filter(
      (e) => e.verdict === 'insufficient' && e.resolver === 'github_pr' && e.threadId === 'thread-A',
    );
    assert.equal(samples.length, 3);
  });

  it('insufficient cap is per-resolver', async () => {
    const baseTs = new Date('2026-06-20T00:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'resolver_A',
          invocationId: `inv-A-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
      await store.record(
        makeEvent({
          verdict: 'insufficient',
          resolver: 'resolver_B',
          invocationId: `inv-B-${i}`,
          ts: baseTs + i * 1000,
        }),
        false,
      );
    }
    const samplesA = (await store.getSamples()).filter((e) => e.resolver === 'resolver_A');
    const samplesB = (await store.getSamples()).filter((e) => e.resolver === 'resolver_B');
    assert.equal(samplesA.length, 3);
    assert.equal(samplesB.length, 3);
  });

  it('insufficient cap resets on new day', async () => {
    const day1 = new Date('2026-06-20T12:00:00Z').getTime();
    const day2 = new Date('2026-06-21T12:00:00Z').getTime();

    for (let i = 0; i < 5; i++) {
      await store.record(
        makeEvent({ verdict: 'insufficient', resolver: 'github_pr', invocationId: `inv-d1-${i}`, ts: day1 + i * 1000 }),
        false,
      );
    }
    for (let i = 0; i < 5; i++) {
      await store.record(
        makeEvent({ verdict: 'insufficient', resolver: 'github_pr', invocationId: `inv-d2-${i}`, ts: day2 + i * 1000 }),
        false,
      );
    }
    const samples = (await store.getSamples()).filter((e) => e.verdict === 'insufficient');
    assert.equal(samples.length, 6); // 3 from day 1 + 3 from day 2
  });

  // ── Verified: 1/N rate + daily cap ────────────────────────

  it('verified daily cap enforced', async () => {
    const dailyStore = new RedisGroundingSampleStore(redis, {
      verifiedDailyCap: 3,
      shouldSampleVerified: () => true,
    });
    for (let i = 0; i < 10; i++) {
      await dailyStore.record(makeEvent({ verdict: 'verified', invocationId: `inv-v-${i}`, ts: Date.now() }), false);
    }
    const samples = (await dailyStore.getSamples()).filter((e) => e.verdict === 'verified');
    assert.equal(samples.length, 3);
  });

  // ── Stats ─────────────────────────────────────────────────

  it('getStats returns stored and dropped counts', async () => {
    const cappedStore = new RedisGroundingSampleStore(redis, {
      verifiedDailyCap: 1,
      shouldSampleVerified: () => true,
    });
    // 1 mismatch (always stored) + 1 verified (stored) + 1 verified (dropped — over cap)
    await cappedStore.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-s1' }), false);
    await cappedStore.record(makeEvent({ verdict: 'verified', invocationId: 'inv-s2', ts: Date.now() }), false);
    await cappedStore.record(makeEvent({ verdict: 'verified', invocationId: 'inv-s3', ts: Date.now() }), false);
    const stats = await cappedStore.getStats();
    assert.equal(stats.stored, 2);
    assert.equal(stats.dropped, 1);
  });

  // ── Max capacity ──────────────────────────────────────────

  it('enforces global max capacity with FIFO eviction', async () => {
    const smallStore = new RedisGroundingSampleStore(redis, { maxTotal: 5 });
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await smallStore.record(
        makeEvent({ verdict: 'mismatch', invocationId: `inv-cap-${i}`, ts: now + i * 1000 }),
        false,
      );
    }
    const samples = await smallStore.getSamples();
    assert.equal(samples.length, 5);
    // FIFO: oldest evicted, newest kept
    assert.equal(samples[0].invocationId, 'inv-cap-5');
    assert.equal(samples[4].invocationId, 'inv-cap-9');
  });

  // ── Time-window filtering (P1 fix: getSamples must exclude stale samples) ──

  it('getSamples excludes samples older than TTL window', async () => {
    const shortTtlStore = new RedisGroundingSampleStore(redis, { ttlSeconds: 3600 }); // 1h window
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600 * 1000; // older than 1h window
    const thirtyMinAgo = now - 30 * 60 * 1000; // within 1h window

    await shortTtlStore.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-old', ts: twoHoursAgo }), false);
    await shortTtlStore.record(makeEvent({ verdict: 'mismatch', invocationId: 'inv-recent', ts: thirtyMinAgo }), false);

    const samples = await shortTtlStore.getSamples();
    assert.equal(samples.length, 1, 'Should only return samples within TTL window');
    assert.equal(samples[0].invocationId, 'inv-recent');
  });

  // ── TTL ───────────────────────────────────────────────────

  it('samples key has TTL set (8-day default)', async () => {
    await store.record(makeEvent({ verdict: 'mismatch' }), false);
    // Check TTL on the sorted set key — should be approximately 8 days (691200s)
    const ttl = await redis.ttl('grounding:samples');
    assert.ok(ttl > 691000, `Expected TTL ~691200s, got ${ttl}`);
    assert.ok(ttl <= 691200, `Expected TTL <= 691200s, got ${ttl}`);
  });
});
