import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  PawFeelReconciliationCoverageKey,
  RedisPawFeelReconciliationCoverageStore,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/coverage-store.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const START = '2026-07-19T12:00:00.000Z';
const ACTIVATED = '2026-07-26T11:59:59.000Z';
const ATTEMPT = '2026-07-26T12:00:00.000Z';
const COMPLETE = '2026-07-26T12:00:01.000Z';

describe('RedisPawFeelReconciliationCoverageStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F278 reconciliation coverage');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisPawFeelReconciliationCoverageStore(redis);
  });

  after(async () => {
    if (!redis || !connected) return;
    await redis.del(PawFeelReconciliationCoverageKey);
    await redis.quit();
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await redis.del(PawFeelReconciliationCoverageKey);
  });

  it('initializes once, preserves successful boundaries through failure, and never applies TTL', async () => {
    assert.deepEqual(await store.getOrInitialize(START, ACTIVATED), {
      coverageStartAt: START,
      typedCaptureActivatedAt: ACTIVATED,
      status: 'uninitialized',
    });
    assert.equal(
      (await store.getOrInitialize('2026-07-20T00:00:00.000Z', COMPLETE)).typedCaptureActivatedAt,
      ACTIVATED,
    );

    await store.recordStarted('full', ATTEMPT);
    const healthy = await store.recordSucceeded('full', ATTEMPT, COMPLETE, ATTEMPT);
    assert.deepEqual(healthy, {
      coverageStartAt: START,
      typedCaptureActivatedAt: ACTIVATED,
      lastFullScanStartedAt: ATTEMPT,
      lastFullScanCompletedAt: COMPLETE,
      lastSeenTimelineAt: ATTEMPT,
      status: 'healthy',
      lagMs: 0,
    });

    const unavailable = await store.recordUnavailable('overlap', COMPLETE, 'timeline unavailable');
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.unavailableReason, 'timeline unavailable');
    assert.equal(unavailable.lastFullScanCompletedAt, COMPLETE);
    assert.equal(unavailable.lastSeenTimelineAt, ATTEMPT);
    assert.equal(await redis.ttl(PawFeelReconciliationCoverageKey), -1);
  });

  it('clears an unavailable reason only after a complete overlap scan', async () => {
    await store.getOrInitialize(START, ACTIVATED);
    await store.recordUnavailable('full', ATTEMPT, 'redis unavailable');

    const recovered = await store.recordSucceeded('overlap', COMPLETE, COMPLETE, COMPLETE);

    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.unavailableReason, undefined);
    assert.equal(recovered.lastOverlapCompletedAt, COMPLETE);
    assert.equal(recovered.lastSeenTimelineAt, COMPLETE);
  });
});
