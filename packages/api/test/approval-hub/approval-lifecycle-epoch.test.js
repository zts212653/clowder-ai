import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'test:f313:approval-epoch:';

describe('F246 producer lifecycle epoch authority', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisApprovalLifecycleEpochAuthority;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F246 producer lifecycle epoch authority');
    const [{ createRedisClient }, module] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/approval-hub/ApprovalLifecycleEpochAuthority.js'),
    ]);
    RedisApprovalLifecycleEpochAuthority = module.RedisApprovalLifecycleEpochAuthority;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  it('persists TTL=0 across a restarted authority and converges monotonically', async () => {
    const first = new RedisApprovalLifecycleEpochAuthority(redis);
    const legacy = await first.initializeLegacy('F266', 7, '2026-09-02T00:00:00.000Z');
    assert.equal(legacy.phase, 'legacy_active');
    assert.equal(await redis.ttl('approval:lifecycle-epoch:F266'), -1);

    const restarted = new RedisApprovalLifecycleEpochAuthority(redis);
    const draining = await restarted.transition({
      producerId: 'F266',
      expectedEpoch: 7,
      expectedRevision: 0,
      to: 'draining',
      occurredAt: '2026-09-02T00:01:00.000Z',
    });
    assert.equal(draining.phase, 'draining');
    assert.deepEqual(await restarted.authorize('F266', 'legacy', 'decision'), { allowed: true, record: draining });
    assert.equal((await restarted.authorize('F266', 'legacy', 'proposal_ingress')).allowed, false);

    await assert.rejects(
      () =>
        restarted.transition({
          producerId: 'F266',
          expectedEpoch: 7,
          expectedRevision: 1,
          to: 'v1_active',
          occurredAt: '2026-09-02T00:02:00.000Z',
          cutoverReceiptRef: 'receipt:skipped-fence',
        }),
      /illegal.*draining.*v1_active/i,
    );

    const fenced = await restarted.transition({
      producerId: 'F266',
      expectedEpoch: 7,
      expectedRevision: 1,
      to: 'fenced',
      occurredAt: '2026-09-02T00:03:00.000Z',
    });
    assert.equal((await restarted.authorize('F266', 'legacy', 'decision')).allowed, false);
    assert.equal((await restarted.authorize('F266', 'legacy', 'recovery_lease')).allowed, false);
    assert.equal(fenced.phase, 'fenced');

    const afterFenceRestart = new RedisApprovalLifecycleEpochAuthority(redis);
    const active = await afterFenceRestart.transition({
      producerId: 'F266',
      expectedEpoch: 7,
      expectedRevision: 2,
      to: 'v1_active',
      occurredAt: '2026-09-02T00:04:00.000Z',
      quiescence: { activeDecisionCommands: 0, materializationAttempts: 0, recoveryLeases: 0 },
      cutoverReceiptRef: 'receipt:f266:v1',
    });
    assert.equal((await afterFenceRestart.authorize('F266', 'v1', 'proposal_ingress')).allowed, true);
    assert.equal((await afterFenceRestart.authorize('F266', 'legacy', 'decision')).allowed, false);
    assert.equal(active.cutoverReceiptRef, 'receipt:f266:v1');
    assert.equal(await redis.ttl('approval:lifecycle-epoch:F266'), -1);
  });

  it('fences first, then refuses the v1 writer until old work is quiescent', async () => {
    const authority = new RedisApprovalLifecycleEpochAuthority(redis);
    await authority.initializeLegacy('F266', 1, '2026-09-02T00:00:00.000Z');
    await authority.transition({
      producerId: 'F266',
      expectedEpoch: 1,
      expectedRevision: 0,
      to: 'draining',
      occurredAt: '2026-09-02T00:01:00.000Z',
    });
    const fenced = await authority.transition({
      producerId: 'F266',
      expectedEpoch: 1,
      expectedRevision: 1,
      to: 'fenced',
      occurredAt: '2026-09-02T00:02:00.000Z',
    });
    assert.equal(fenced.phase, 'fenced');
    await assert.rejects(
      () =>
        authority.transition({
          producerId: 'F266',
          expectedEpoch: 1,
          expectedRevision: 2,
          to: 'v1_active',
          occurredAt: '2026-09-02T00:03:00.000Z',
          quiescence: { activeDecisionCommands: 0, materializationAttempts: 1, recoveryLeases: 0 },
          cutoverReceiptRef: 'receipt:f266:v1',
        }),
      /quiescence/i,
    );
  });

  it('fails closed on missing, corrupt, stale CAS, and read errors for both generations', async () => {
    const authority = new RedisApprovalLifecycleEpochAuthority(redis);
    for (const writer of ['legacy', 'v1']) {
      const missing = await authority.authorize('F266', writer, 'decision');
      assert.equal(missing.allowed, false);
      assert.equal(missing.reason, 'epoch_missing');
    }

    await redis.set('approval:lifecycle-epoch:F266', '{broken');
    for (const writer of ['legacy', 'v1']) {
      const corrupt = await authority.authorize('F266', writer, 'decision');
      assert.equal(corrupt.allowed, false);
      assert.equal(corrupt.reason, 'epoch_corrupt');
    }

    await redis.set(
      'approval:lifecycle-epoch:F266',
      JSON.stringify({
        producerId: 'F221',
        epoch: 2,
        revision: 0,
        phase: 'legacy_active',
        updatedAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    for (const writer of ['legacy', 'v1']) {
      const mismatched = await authority.authorize('F266', writer, 'decision');
      assert.equal(mismatched.allowed, false);
      assert.equal(mismatched.reason, 'epoch_corrupt');
    }
    await assert.rejects(
      () =>
        authority.transition({
          producerId: 'F266',
          expectedEpoch: 2,
          expectedRevision: 0,
          to: 'draining',
          occurredAt: '2026-09-02T00:01:00.000Z',
        }),
      /producer mismatch|corrupt/i,
    );

    await redis.del('approval:lifecycle-epoch:F266');
    await authority.initializeLegacy('F266', 2, '2026-09-02T00:00:00.000Z');
    await assert.rejects(
      () =>
        authority.transition({
          producerId: 'F266',
          expectedEpoch: 2,
          expectedRevision: 99,
          to: 'draining',
          occurredAt: '2026-09-02T00:01:00.000Z',
        }),
      /CAS conflict/i,
    );

    const failing = new RedisApprovalLifecycleEpochAuthority({
      async get() {
        throw new Error('read failed');
      },
    });
    for (const writer of ['legacy', 'v1']) {
      const unreadable = await failing.authorize('F266', writer, 'decision');
      assert.equal(unreadable.allowed, false);
      assert.equal(unreadable.reason, 'epoch_read_failed');
    }
  });
});
