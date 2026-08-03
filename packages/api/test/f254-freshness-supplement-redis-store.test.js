import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

const { RedisFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/RedisFreshnessClosureStore.js'
);
const { FreshnessSupplementKeys } = await import(
  '../dist/domains/cats/services/stores/redis-keys/freshness-closure-keys.js'
);

const base = {
  lineageId: 'message-original',
  originalMessageId: 'message-original',
  userId: 'user-supplement-redis',
  threadId: 'thread-supplement-redis',
  catId: 'codex-sol',
  requiredMessageIds: ['message-update-1'],
  requiredFrontierMessageId: 'message-update-1',
  replayUnsafeToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
  now: 100,
};

describe('Redis F254 supplement lifecycle', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis F254 supplement lifecycle');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisFreshnessClosureStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['freshness:supplement:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['freshness:supplement:*']);
    await redis.quit();
  });

  it('atomically opens one seq 1 and coalesces concurrent observations without TTL', async () => {
    await Promise.all([
      store.offerSupplement({
        ...base,
        requiredMessageIds: ['message-update-3'],
        requiredFrontierMessageId: 'message-update-3',
        now: 130,
      }),
      store.offerSupplement({
        ...base,
        requiredMessageIds: ['message-update-2'],
        requiredFrontierMessageId: 'message-update-2',
        now: 120,
      }),
    ]);

    const [supplement] = await store.listSupplementsByLineage(base.lineageId);
    assert.equal(supplement.seq, 1);
    assert.equal(supplement.status, 'pending');
    assert.deepEqual(supplement.requiredMessageIds, ['message-update-2', 'message-update-3']);
    assert.equal(supplement.requiredFrontierMessageId, 'message-update-3');
    assert.equal(supplement.updatedAt, 130);
    assert.equal(await redis.ttl(FreshnessSupplementKeys.detail(supplement.id)), -1);
    assert.equal(await redis.ttl(FreshnessSupplementKeys.lineage(base.lineageId)), -1);
    assert.equal(await redis.ttl(FreshnessSupplementKeys.thread(base.threadId)), -1);
    assert.equal(await redis.ttl(FreshnessSupplementKeys.ALL), -1);
  });

  it('serializes one running lease, preserves terminal state, and makes budget exhaustion visible', async () => {
    const first = (await store.offerSupplement(base)).supplement;
    await store.claimSupplement(first.id, { invocationId: 'inv-s1', now: 110 });
    await Promise.all([
      store.offerSupplement({
        ...base,
        requiredMessageIds: ['message-update-2'],
        requiredFrontierMessageId: 'message-update-2',
        now: 120,
      }),
      store.offerSupplement({
        ...base,
        requiredMessageIds: ['message-update-3'],
        requiredFrontierMessageId: 'message-update-3',
        now: 130,
      }),
    ]);
    const [, second] = await store.listSupplementsByLineage(base.lineageId);

    assert.deepEqual(second.requiredMessageIds, ['message-update-2', 'message-update-3']);
    await assert.rejects(
      store.claimSupplement(second.id, { invocationId: 'inv-s2', now: 140 }),
      /already has a running supplement/,
    );
    await assert.rejects(
      store.commitSupplement(first.id, {
        invocationId: 'inv-wrong',
        messageId: 'message-supplement-1',
        now: 140,
      }),
      /claimed invocation/,
    );

    await store.commitSupplement(first.id, {
      invocationId: 'inv-s1',
      messageId: 'message-supplement-1',
      now: 150,
    });
    await store.claimSupplement(second.id, { invocationId: 'inv-s2', now: 160 });
    const exhausted = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-4'],
      requiredFrontierMessageId: 'message-update-4',
      now: 170,
    });
    assert.equal(exhausted.kind, 'budget_exhausted');
    assert.equal(exhausted.supplement.status, 'running');
    assert.deepEqual(exhausted.supplement.budgetExhausted, {
      unseenMessageIds: ['message-update-4'],
      observedAt: 170,
    });

    await store.failSupplement(second.id, {
      invocationId: 'inv-s2',
      reason: 'provider_failure',
      now: 180,
    });
    const hydratedStore = new RedisFreshnessClosureStore(redis);
    const hydrated = await hydratedStore.getSupplement(second.id);
    assert.equal(hydrated.status, 'failed');
    assert.equal(hydrated.failureReason, 'provider_failure');
    assert.deepEqual(hydrated.budgetExhausted, exhausted.supplement.budgetExhausted);
    assert.equal(await redis.get(FreshnessSupplementKeys.runningLease(base.lineageId)), null);
  });

  it('enumerates only pending and running supplements for startup recovery', async () => {
    const pending = (await store.offerSupplement(base)).supplement;
    const running = (
      await store.offerSupplement({
        ...base,
        lineageId: 'message-running',
        originalMessageId: 'message-running',
      })
    ).supplement;
    await store.claimSupplement(running.id, { invocationId: 'inv-running', now: 120 });
    const terminal = (
      await store.offerSupplement({
        ...base,
        lineageId: 'message-terminal',
        originalMessageId: 'message-terminal',
      })
    ).supplement;
    await store.failSupplement(terminal.id, { reason: 'infrastructure', now: 130 });

    const recoverable = await store.listRecoverableSupplements();

    assert.deepEqual(
      recoverable.map((supplement) => [supplement.id, supplement.status]),
      [
        [pending.id, 'pending'],
        [running.id, 'running'],
      ],
    );
  });

  it('cascades thread deletion through supplement detail, lineage, thread, and lease indexes', async () => {
    const target = (await store.offerSupplement(base)).supplement;
    await store.claimSupplement(target.id, { invocationId: 'inv-target', now: 110 });
    const other = (
      await store.offerSupplement({
        ...base,
        lineageId: 'message-other',
        originalMessageId: 'message-other',
        threadId: 'thread-2',
      })
    ).supplement;

    assert.equal(await store.deleteByThread(base.threadId), 1);
    assert.equal(await redis.get(FreshnessSupplementKeys.detail(target.id)), null);
    assert.equal(await redis.exists(FreshnessSupplementKeys.lineage(base.lineageId)), 0);
    assert.equal(await redis.exists(FreshnessSupplementKeys.runningLease(base.lineageId)), 0);
    assert.equal(await redis.exists(FreshnessSupplementKeys.thread(base.threadId)), 0);
    assert.equal((await store.getSupplement(other.id)).threadId, 'thread-2');
  });
});
