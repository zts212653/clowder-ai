// @ts-check
/**
 * F268 P2-1: Redis production-path test for RedisTipEventSink.
 *
 * Verifies the Lua script atomic receipt+aggregate write works against real Redis.
 * Uses the isolated Redis harness on a disposable non-6399 port.
 *
 * Run: pnpm --filter @cat-cafe/api test:redis -- --grep "tip-telemetry-sink"
 *
 * Sol R2 fixes:
 * - Removed manual prefix duplication (ioredis keyPrefix handles namespacing)
 * - Use cleanupClientKeyspace (keyPrefix-aware cleanup)
 * - Aggregate test asserts counter values + TTL
 * - Fixed timestamp for deterministic date bucket assertions
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SUITE_NAME = 'redis-tip-telemetry-sink';

describe('F268 RedisTipEventSink (production path)', { skip: redisIsolationSkipReason(REDIS_URL, SUITE_NAME) }, () => {
  /** @type {import('ioredis').default} */
  let redis;
  /** @type {import('../dist/routes/tip-telemetry.js').RedisTipEventSink} */
  let sink;
  /** @type {import('../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js').CapabilityTipsUsageAdapter} */
  let usageAdapter;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, SUITE_NAME);

    const Redis = (await import('ioredis')).default;
    // keyPrefix auto-prepends to all key operations — no manual prefix in assertions
    redis = new Redis(REDIS_URL, { keyPrefix: 'f268test:' });
    await redis.ping();

    const { RedisTipEventSink } = await import('../dist/routes/tip-telemetry.js');
    const { CapabilityTipsUsageAdapter } = await import(
      '../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    sink = new RedisTipEventSink(redis);
    usageAdapter = new CapabilityTipsUsageAdapter(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      redis.disconnect();
    }
  });

  const makeBatch = (batchId, events) => ({
    batchId,
    attempt: 1,
    events,
    assembledAt: Date.now(),
    schemaVersion: 1,
  });

  // Fixed timestamp for deterministic date bucket: 1721000000000 = 2024-07-14 UTC
  const FIXED_TS = 1721000000000;

  const makeEvent = (tipId, outcome = 'shown') => ({
    event: /** @type {const} */ ('capability_tip_exposed'),
    tipId,
    context: /** @type {const} */ ('thinking'),
    surface: /** @type {const} */ ('pending_bubble'),
    outcome: /** @type {const} */ (outcome),
    timestamp: FIXED_TS,
  });

  it('accepts a new batch and stores receipt + aggregates', async () => {
    const batch = makeBatch('a50e8400-e29b-41d4-a716-446655440099', [makeEvent('redis-tip-1')]);
    const result = await sink.ingest(batch, 'user-1');

    assert.equal(result.status, 'accepted');
    assert.equal(result.eventCount, 1);

    // ioredis GET auto-prepends keyPrefix, so use the logical key only
    const receiptRaw = await redis.get('tip-telemetry:receipt:user-1:a50e8400-e29b-41d4-a716-446655440099');
    assert.ok(receiptRaw, 'receipt should exist');
    const receipt = JSON.parse(receiptRaw);
    assert.ok(receipt.digest, 'receipt should have digest');
    assert.equal(receipt.eventCount, 1);
  });

  it('returns duplicate for same batchId with same events', async () => {
    const batch = makeBatch('b50e8400-e29b-41d4-a716-446655440099', [makeEvent('redis-tip-2')]);

    const r1 = await sink.ingest(batch, 'user-2');
    assert.equal(r1.status, 'accepted');

    const r2 = await sink.ingest(batch, 'user-2');
    assert.equal(r2.status, 'duplicate');
  });

  it('returns conflict for same batchId with different events', async () => {
    const batch1 = makeBatch('c50e8400-e29b-41d4-a716-446655440099', [makeEvent('redis-tip-3a')]);
    const batch2 = makeBatch('c50e8400-e29b-41d4-a716-446655440099', [makeEvent('redis-tip-3b')]);

    const r1 = await sink.ingest(batch1, 'user-3');
    assert.equal(r1.status, 'accepted');

    const r2 = await sink.ingest(batch2, 'user-3');
    assert.equal(r2.status, 'conflict');
  });

  it('increments aggregate counters atomically with correct values and TTL', async () => {
    const events = [makeEvent('agg-tip', 'shown'), makeEvent('agg-tip', 'shown'), makeEvent('agg-tip', 'failed')];
    const batch = makeBatch('d50e8400-e29b-41d4-a716-446655440099', events);
    const result = await sink.ingest(batch, 'user-4');
    assert.equal(result.status, 'accepted');
    assert.equal(result.eventCount, 3);

    // Fixed timestamp 1721000000000 = 2024-07-14 UTC
    // Aggregate key format: tip-telemetry:agg:{date}:{tipId}:{event}:{outcome}
    const shownCount = await redis.get('tip-telemetry:agg:2024-07-14:agg-tip:capability_tip_exposed:shown');
    assert.equal(shownCount, '2', 'shown aggregate should be 2');

    const failedCount = await redis.get('tip-telemetry:agg:2024-07-14:agg-tip:capability_tip_exposed:failed');
    assert.equal(failedCount, '1', 'failed aggregate should be 1');

    // Verify TTL was set (90d = 7776000s, allow small variance from test execution time)
    const ttl = await redis.ttl('tip-telemetry:agg:2024-07-14:agg-tip:capability_tip_exposed:shown');
    assert.ok(ttl > 7775000 && ttl <= 7776000, `TTL should be ~90d, got ${ttl}`);
  });

  it('refreshes the rolling aggregate TTL on every accepted increment', async () => {
    const aggregateKey = 'tip-telemetry:agg:2024-07-14:rolling-tip:capability_tip_exposed:shown';
    const firstBatch = makeBatch('d60e8400-e29b-41d4-a716-446655440099', [makeEvent('rolling-tip')]);
    const secondBatch = makeBatch('d70e8400-e29b-41d4-a716-446655440099', [makeEvent('rolling-tip')]);

    assert.equal((await sink.ingest(firstBatch, 'user-rolling')).status, 'accepted');
    await redis.expire(aggregateKey, 60);
    const shortenedTtl = await redis.ttl(aggregateKey);
    assert.ok(shortenedTtl > 0 && shortenedTtl <= 60, `test setup should shorten TTL, got ${shortenedTtl}`);

    assert.equal((await sink.ingest(secondBatch, 'user-rolling')).status, 'accepted');
    const refreshedTtl = await redis.ttl(aggregateKey);
    assert.ok(refreshedTtl > 7775000 && refreshedTtl <= 7776000, `TTL should refresh to ~90d, got ${refreshedTtl}`);
  });

  it('replays durable aggregates through the source adapter with ioredis keyPrefix', async () => {
    const snapshot = await usageAdapter.resolve({
      kind: 'capability-tips-usage-window',
      windowStartMs: Date.UTC(2024, 6, 14),
      windowEndMs: Date.UTC(2024, 6, 15),
    });

    assert.equal(snapshot.status, 'insufficient', 'opportunity denominator is intentionally unavailable');
    assert.equal(snapshot.opportunity.count, null);
    const shown = snapshot.rows.find(
      (row) => row.tipId === 'agg-tip' && row.event === 'capability_tip_exposed' && row.outcome === 'shown',
    );
    const failed = snapshot.rows.find(
      (row) => row.tipId === 'agg-tip' && row.event === 'capability_tip_exposed' && row.outcome === 'failed',
    );
    assert.equal(shown?.count, 2);
    assert.equal(failed?.count, 1);
  });

  it('replays the authenticated HTTP ingress through Redis into the source adapter', async () => {
    const Fastify = (await import('fastify')).default;
    const { tipTelemetryRoutes } = await import('../dist/routes/tip-telemetry.js');
    const app = Fastify();
    const eventTimestamp = Date.UTC(2024, 6, 15, 12);
    const batch = makeBatch('e50e8400-e29b-41d4-a716-446655440099', [
      { ...makeEvent('http-replay-tip', 'opened'), timestamp: eventTimestamp },
    ]);

    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'http-replay-user';
    });
    await app.register(tipTelemetryRoutes, { sink, now: () => eventTimestamp });

    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/tip-telemetry/batch',
        payload: batch,
      });
      assert.equal(accepted.statusCode, 202);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/tip-telemetry/batch',
        payload: { ...batch, attempt: 2 },
      });
      assert.equal(duplicate.statusCode, 202);

      const snapshot = await usageAdapter.resolve({
        kind: 'capability-tips-usage-window',
        windowStartMs: Date.UTC(2024, 6, 15),
        windowEndMs: Date.UTC(2024, 6, 16),
      });
      const replayed = snapshot.rows.find(
        (row) => row.tipId === 'http-replay-tip' && row.event === 'capability_tip_exposed' && row.outcome === 'opened',
      );
      assert.equal(replayed?.count, 1, 'attempt=2 retry must not double-count the aggregate');
    } finally {
      await app.close();
    }
  });

  it('recordTransport atomically writes counter with TTL (Sol R2 P2-2)', async () => {
    // Use a status not written by the HTTP replay above so this assertion has
    // an isolated zero baseline while still sharing the production key family.
    sink.recordTransport('rejected', 5);
    // Give fire-and-forget Lua script time to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Scan raw keys (keys() does NOT auto-prepend, returns full keys)
    const rawKeys = await redis.keys('f268test:tip-telemetry:transport:*:rejected');
    assert.equal(rawKeys.length, 1, 'isolated rejected transport counter key should exist');

    // Read value via ioredis (which auto-prepends keyPrefix on get)
    const logicalKey = rawKeys[0].replace('f268test:', '');
    const value = await redis.get(logicalKey);
    assert.equal(value, '5', 'transport counter should be 5');

    // Verify TTL is set (14d = 1209600s) — proves Lua atomic write
    const ttl = await redis.ttl(logicalKey);
    assert.ok(ttl > 1209000 && ttl <= 1209600, `TTL should be ~14d, got ${ttl}`);
  });
});
