/**
 * F257 V1 — RoutingDecisionFact projection tests (§4.5.1 contract).
 *
 * Semantics single source of truth: F257 redesign doc §4.5.1 (projection
 * coverage contract) + T-A §3.4 (metric columns via routing-attempt.ts).
 * 有 Redis → 测全量；无 Redis → skip（与 redis-message-store.test.js 同模式）。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257';
// Per-file keyPrefix: hard keyspace isolation from concurrently running test
// files (cleanupClientKeyspace precedent — cohort reads join timeline↔hash,
// so another file's `msg:*` wildcard cleanup mid-test corrupts the audit).
const TEST_KEY_PREFIX = 'cat-cafe:f257proj:';

function a2aBatch(overrides = {}) {
  return {
    parserMode: 'a2a',
    spanBasis: 'a2a_normalized',
    attempts: [
      { tokenOrdinal: 0, outcome: 'resolved', token: '@codex', span: { start: 0, end: 6 }, targetCatId: 'codex' },
      { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zzz', span: { start: 7, end: 11 } },
      { tokenOrdinal: 2, outcome: 'duplicate', token: '@缅因猫', span: { start: 12, end: 16 }, targetCatId: 'codex' },
    ],
    truncated: false,
    metricEligible: true,
    ...overrides,
  };
}

function userBatch(overrides = {}) {
  return {
    parserMode: 'user',
    spanBasis: 'lowercased_message',
    attempts: [
      { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
    ],
    truncated: false,
    metricEligible: true,
    ...overrides,
  };
}

describe('F257 V1: RedisRoutingFactProjection', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let store;
  let projection;
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRoutingFactProjection');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const projModule = await import('../dist/domains/cats/services/stores/redis/RedisRoutingFactProjection.js');
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new storeModule.RedisMessageStore(redis);
    projection = new projModule.RedisRoutingFactProjection(redis);
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

  async function appendFactMessage(batch, timestamp, extra = {}) {
    return store.append({
      userId: OWNER,
      catId: batch.parserMode === 'a2a' ? 'opus' : null,
      content: 'seed',
      mentions: [],
      timestamp,
      threadId: 'th-f257-proj',
      routingFact: batch,
      // writer-declared three-axis provenance (author / routed / observation)
      provenance: { author: batch.parserMode === 'a2a' ? 'cat' : 'user', routed: true, observation: 'original' },
      ...extra,
    });
  }

  it('project() indexes a fact message and advances the watermark monotonically', async () => {
    const now = Date.now();
    const m1 = await appendFactMessage(a2aBatch(), now - 1000);
    const m2 = await appendFactMessage(userBatch(), now);
    // project out of order — watermark must end at the max id
    await projection.project(m2);
    await projection.project(m1);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 2000, now + 1);
    assert.deepEqual(new Set(members), new Set([m1.id, m2.id]));
    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, m2.id > m1.id ? m2.id : m1.id);
    const health = await projection.getHealth(OWNER);
    assert.equal(health.ok, true);
    assert.equal(health.errorCount, 0);
  });

  it('project() is a no-op for messages without a fact', async () => {
    const now = Date.now();
    const msg = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: 'no tokens',
      mentions: [],
      timestamp: now,
      threadId: 'th-f257-proj',
    });
    await projection.project(msg);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1, now + 1);
    assert.deepEqual(members, []);
  });

  it('reconcileWindow() rebuilds missing projection entries from authority records (idempotent)', async () => {
    const now = Date.now();
    await appendFactMessage(a2aBatch(), now - 500);
    await appendFactMessage(userBatch(), now - 400);
    // briefing-origin messages are outside the routable cohort — no fact expected
    await store.append({
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: 'no fact',
      mentions: [],
      timestamp: now - 300,
      threadId: 'th-f257-proj',
      origin: 'briefing',
    });

    // No projector ran — projection is empty; reconcile must rebuild from authority.
    const first = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(first.ok, true);
    assert.equal(first.cohortCount, 2, 'briefing message is out of cohort');
    assert.equal(first.authorityCount, 2);
    assert.equal(first.producerGapCount, 0);
    assert.equal(first.repairedMissing, 2);
    assert.equal(first.removedStale, 0);

    const second = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(second.ok, true);
    assert.equal(second.repairedMissing, 0, 'idempotent — nothing left to repair');
    assert.equal(second.projectedCount, 2);
  });

  it('R7: queued routed message remains measurable in delivery-time windows and after owner reassignment', async () => {
    const deliveredAt = Date.now();
    const nextOwner = `${OWNER}-reassigned`;
    const msg = await appendFactMessage(userBatch(), deliveredAt - 60_000, { deliveryStatus: 'queued' });
    await store.markDelivered(msg.id, deliveredAt);

    const delivered = await projection.computeResolutionRate(OWNER, deliveredAt - 100, deliveredAt + 100);
    assert.equal(delivered.unmeasurable, false);
    assert.equal(delivered.coverage.cohortCount, 1);

    await store.reassignUserId(msg.id, nextOwner);
    const reassigned = await projection.computeResolutionRate(nextOwner, deliveredAt - 100, deliveredAt + 100);
    assert.equal(reassigned.unmeasurable, false);
    assert.equal(reassigned.coverage.cohortCount, 1);
    const oldOwner = await projection.computeResolutionRate(OWNER, deliveredAt - 100, deliveredAt + 100);
    assert.equal(oldOwner.unmeasurable, false);
    assert.equal(oldOwner.coverage.cohortCount, 0);
  });

  it('R11: reassign before delayed delivery converges on the current owner and delivery coordinate', async () => {
    const sentAt = Date.now() - 10_000;
    const deliveredAt = sentAt + 5_000;
    const nextOwner = `${OWNER}-r11-reassign-first`;
    const msg = await appendFactMessage(userBatch(), sentAt, { deliveryStatus: 'queued' });

    const originalEval = redis.eval.bind(redis);
    let announceDeliveryCommit;
    let releaseDeliveryCommit;
    const deliveryCommit = new Promise((resolve) => {
      announceDeliveryCommit = resolve;
    });
    const deliveryRelease = new Promise((resolve) => {
      releaseDeliveryCommit = resolve;
    });
    let pauseDelivery = true;
    redis.eval = async (...args) => {
      const script = String(args[0] ?? '');
      if (pauseDelivery && script.includes("'deliveryStatus', 'delivered'")) {
        pauseDelivery = false;
        announceDeliveryCommit();
        await deliveryRelease;
      }
      return originalEval(...args);
    };

    try {
      const delivery = store.markDelivered(msg.id, deliveredAt);
      await deliveryCommit;
      assert.ok(await store.reassignUserId(msg.id, nextOwner));
      releaseDeliveryCommit();
      assert.ok(await delivery);
    } finally {
      releaseDeliveryCommit?.();
      redis.eval = originalEval;
    }

    assert.deepEqual(await redis.hmget(`msg:${msg.id}`, 'userId', 'deliveredAt'), [nextOwner, String(deliveredAt)]);
    assert.equal(await redis.zscore(`msg:user:${OWNER}`, msg.id), null, 'delivery must not recreate old owner');
    assert.equal(await redis.zscore(`msg:user:${nextOwner}`, msg.id), String(deliveredAt));
    assert.equal(await redis.zscore('msg:timeline', msg.id), String(deliveredAt));
    assert.equal(await redis.zscore(`msg:thread:${msg.threadId}`, msg.id), String(deliveredAt));

    const rate = await projection.computeResolutionRate(nextOwner, deliveredAt - 100, deliveredAt + 100);
    assert.equal(rate.unmeasurable, false);
    assert.equal(rate.coverage.cohortCount, 1, 'delivery-time exact cohort must include the reassigned message');
  });

  it('R11: delivery before delayed reassign moves the commit-time effective order to the new owner', async () => {
    const sentAt = Date.now() - 10_000;
    const deliveredAt = sentAt + 5_000;
    const nextOwner = `${OWNER}-r11-delivery-first`;
    const msg = await appendFactMessage(userBatch(), sentAt, { deliveryStatus: 'queued' });

    const originalEval = redis.eval.bind(redis);
    let announceReassignCommit;
    let releaseReassignCommit;
    const reassignCommit = new Promise((resolve) => {
      announceReassignCommit = resolve;
    });
    const reassignRelease = new Promise((resolve) => {
      releaseReassignCommit = resolve;
    });
    let pauseReassign = true;
    redis.eval = async (...args) => {
      const script = String(args[0] ?? '');
      if (pauseReassign && script.includes("'userId', nextUserId")) {
        pauseReassign = false;
        announceReassignCommit();
        await reassignRelease;
      }
      return originalEval(...args);
    };

    try {
      const reassignment = store.reassignUserId(msg.id, nextOwner);
      await reassignCommit;
      assert.ok(await store.markDelivered(msg.id, deliveredAt));
      releaseReassignCommit();
      const reassigned = await reassignment;
      assert.ok(reassigned);
      assert.equal(reassigned.userId, nextOwner);
      assert.equal(reassigned.deliveryStatus, 'delivered', 'return value must reflect commit-time authority state');
      assert.equal(reassigned.deliveredAt, deliveredAt, 'return value must include commit-time effective order');
    } finally {
      releaseReassignCommit?.();
      redis.eval = originalEval;
    }

    assert.deepEqual(await redis.hmget(`msg:${msg.id}`, 'userId', 'deliveredAt'), [nextOwner, String(deliveredAt)]);
    assert.equal(await redis.zscore(`msg:user:${OWNER}`, msg.id), null);
    assert.equal(
      await redis.zscore(`msg:user:${nextOwner}`, msg.id),
      String(deliveredAt),
      'reassign must derive score from authority at Lua commit time',
    );
    assert.equal(await redis.zscore('msg:timeline', msg.id), String(deliveredAt));
    assert.equal(await redis.zscore(`msg:thread:${msg.threadId}`, msg.id), String(deliveredAt));

    const rate = await projection.computeResolutionRate(nextOwner, deliveredAt - 100, deliveredAt + 100);
    assert.equal(rate.unmeasurable, false);
    assert.equal(rate.coverage.cohortCount, 1, 'delivery-time exact cohort must include the reassigned message');
  });

  it('R11: a stale projector snapshot derives routing score from commit-time effective order', async () => {
    const sentAt = Date.now() - 10_000;
    const deliveredAt = sentAt + 5_000;
    const msg = await appendFactMessage(userBatch(), sentAt, { deliveryStatus: 'queued' });

    assert.ok(await store.markDelivered(msg.id, deliveredAt));
    await projection.project(msg);

    assert.equal(
      await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id),
      String(deliveredAt),
      'projector must not restore the stale sentAt score after delivery',
    );
  });

  it('R12: same-owner reassignment returns authority changes that committed after its pre-read', async () => {
    const sentAt = Date.now() - 10_000;
    const deliveredAt = sentAt + 5_000;
    const msg = await appendFactMessage(userBatch(), sentAt, { deliveryStatus: 'queued' });

    const originalEval = redis.eval.bind(redis);
    let announceNoopCommit;
    let releaseNoopCommit;
    const noopCommit = new Promise((resolve) => {
      announceNoopCommit = resolve;
    });
    const noopRelease = new Promise((resolve) => {
      releaseNoopCommit = resolve;
    });
    let pauseNoop = true;
    redis.eval = async (...args) => {
      const script = String(args[0] ?? '');
      if (pauseNoop && script.includes('curUserId == nextUserId')) {
        pauseNoop = false;
        announceNoopCommit();
        await noopRelease;
      }
      return originalEval(...args);
    };

    try {
      const reassignment = store.reassignUserId(msg.id, OWNER);
      await noopCommit;
      assert.ok(await store.markDelivered(msg.id, deliveredAt));
      releaseNoopCommit();
      const reassigned = await reassignment;
      assert.ok(reassigned);
      assert.equal(reassigned.userId, OWNER);
      assert.equal(reassigned.deliveryStatus, 'delivered');
      assert.equal(reassigned.deliveredAt, deliveredAt);
    } finally {
      releaseNoopCommit?.();
      redis.eval = originalEval;
    }
  });

  it('R12: projection-first delivery converges at the reconcile-before-evaluate boundary', async () => {
    const sentAt = Date.now() - 10_000;
    const deliveredAt = sentAt + 5_000;
    const msg = await appendFactMessage(userBatch(), sentAt, { deliveryStatus: 'queued' });

    await projection.project(msg);
    assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), String(sentAt));

    assert.ok(await store.markDelivered(msg.id, deliveredAt));
    assert.equal(
      await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id),
      String(sentAt),
      'async query projection may remain stale until the mandatory reconcile boundary',
    );

    const coverage = await projection.reconcileWindow(OWNER, deliveredAt - 100, deliveredAt + 100);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.repairedMissing, 1);
    assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), String(deliveredAt));
  });

  it('reconcileWindow() flags a routed message without a fact as a producer gap (sol R1/R3 P1-1)', async () => {
    const now = Date.now();
    await appendFactMessage(userBatch(), now - 500);
    // The append boundary enforces routed ⇔ fact, so a gap can only come from an
    // out-of-band write or a broken producer — simulate one by corrupting the
    // provenance field after a legal surface append.
    const broken = await store.append({
      userId: OWNER,
      catId: null,
      content: '@opus 看下',
      mentions: ['opus'],
      timestamp: now - 400,
      threadId: 'th-f257-proj',
      provenance: { author: 'user', routed: false, observation: 'original' },
    });
    await redis.hset(`msg:${broken.id}`, {
      provenance: JSON.stringify({ author: 'user', routed: true, observation: 'original' }),
    });

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false, 'producer gap must not report a healthy window');
    assert.equal(coverage.reason, 'producer_gap');
    assert.equal(coverage.cohortCount, 2);
    assert.equal(coverage.authorityCount, 1);
    assert.equal(coverage.producerGapCount, 1);

    const rate = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(rate.unmeasurable, true);
    assert.equal(rate.reason, 'producer_gap');
    assert.equal(rate.coverage.producerGapCount, 1);
  });

  it('surface messages without a routed lane are out of cohort (sol R2 P1-1 repro)', async () => {
    const now = Date.now();
    await appendFactMessage(userBatch(), now - 500);
    // sol repro: a normal proposal rich card — owner userId, catId null, no
    // source, NO lane declaration — previously misjudged as a producer gap.
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: '📋 新 thread 提案卡片',
      mentions: [],
      timestamp: now - 450,
      threadId: 'th-f257-proj',
      extra: { rich: { v: 1, blocks: [] } },
    });
    // system-notice shape (source-carrying), also lane-less
    await store.append({
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: '服务刚重启，请重新发送。',
      mentions: [],
      timestamp: now - 400,
      threadId: 'th-f257-proj',
      source: { connector: 'startup-reconciler', label: '重启提醒', icon: '🔄' },
    });

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, true, 'surface messages must not count as producer gaps');
    assert.equal(coverage.cohortCount, 1, 'only the routed-lane message is in cohort');
    assert.equal(coverage.producerGapCount, 0);

    const rate = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(rate.unmeasurable, false, 'window with surface messages stays measurable');
  });

  it('zero-token batches persist and count as authority (producer-run marker, sol R1 P1-1)', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch({ attempts: [] }), now - 200);
    await projection.project(msg);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 300, now);
    assert.deepEqual(members, [msg.id], 'empty batch is indexed');

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.cohortCount, 1);
    assert.equal(coverage.authorityCount, 1);
    assert.equal(coverage.producerGapCount, 0);
  });

  it('sol R4 P1-1c: malformed provenance -> window unmeasurable; absent legacy -> measurable, out of cohort', async () => {
    const now = Date.now();
    await appendFactMessage(userBatch(), now - 500);
    const bad = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: 'surface message',
      mentions: [],
      timestamp: now - 400,
      threadId: 'th-f257-proj',
    });
    // storage fault repro (sol R4): corrupt the persisted declaration
    await redis.hset(`msg:${bad.id}`, { provenance: '{"author":"user"' });
    const rec = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(rec.ok, false, 'corrupt declaration = cohort boundary unknowable');
    assert.equal(rec.reason, 'malformed_provenance');

    // absent (legacy pre-contract) is a DIFFERENT fact: window stays measurable
    await redis.hdel(`msg:${bad.id}`, 'provenance');
    const rec2 = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(rec2.ok, true);
    assert.equal(rec2.cohortCount, 1, 'legacy message honestly out of cohort');
    // out-of-domain author is malformed too, not silently non-routed
    await redis.hset(`msg:${bad.id}`, {
      provenance: JSON.stringify({ author: 'ghost', routed: true, observation: 'original' }),
    });
    const rec3 = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(rec3.ok, false);
    assert.equal(rec3.reason, 'malformed_provenance');
  });

  it('R5: missing detail hash is a collection gap, never a healthy legacy-sized window', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.del(`msg:${msg.id}`); // owner timeline survives; authority hash does not

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false);
    assert.equal(coverage.reason, 'collection_gap');

    const rate = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(rate.unmeasurable, true);
    assert.equal(rate.reason, 'reconcile_failed');
  });

  it('R5: persisted routingFact/provenance contradictions make the window unmeasurable', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.hset(
      `msg:${msg.id}`,
      'provenance',
      JSON.stringify({ author: 'user', routed: false, observation: 'original' }),
    );

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false, 'fact present + routed:false cannot silently leave the cohort');
    assert.equal(coverage.reason, 'malformed_provenance');

    await redis.hdel(`msg:${msg.id}`, 'provenance');
    const undeclaredFact = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(undeclaredFact.ok, false, 'a fact without any provenance declaration is not a legacy surface row');
    assert.equal(undeclaredFact.reason, 'malformed_provenance');
  });

  it('R6: empty or malformed routingFact fails during canonical reconcile', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);

    await redis.hset(`msg:${msg.id}`, 'routingFact', '');
    const empty = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'malformed_authority_fact');

    await redis.hset(`msg:${msg.id}`, 'routingFact', '{');
    const malformed = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reason, 'malformed_authority_fact');
  });

  it('R8: soft-deleted routed authority is excluded until restore', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await projection.project(msg);

    await store.softDelete(msg.id, OWNER);
    const deleted = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.cohortCount, 0);
    assert.equal(deleted.authorityCount, 0);
    assert.equal(deleted.removedStale, 1);

    await store.restore(msg.id);
    const restored = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(restored.ok, true);
    assert.equal(restored.cohortCount, 1);
    assert.equal(restored.authorityCount, 1);
    assert.equal(restored.repairedMissing, 1);
  });

  it('R8: hard delete scrubs embedded authority and its query projection', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await projection.project(msg);

    await store.hardDelete(msg.id, OWNER);

    assert.equal(await redis.hget(`msg:${msg.id}`, 'routingFact'), null);
    assert.equal(await redis.hget(`msg:${msg.id}`, 'provenance'), null);
    assert.deepEqual(await redis.zrange(`routing-fact:idx:${OWNER}`, 0, -1), []);
    const result = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(result.ok, true);
    assert.equal(result.cohortCount, 0);
    assert.equal(result.authorityCount, 0);
  });

  it('R8: physical thread deletion removes owner and routing projections atomically enough for exact reads', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await projection.project(msg);

    assert.equal(await store.deleteByThread(msg.threadId), 1);

    assert.deepEqual(await redis.zrange(`msg:user:${OWNER}`, 0, -1), []);
    assert.deepEqual(await redis.zrange(`routing-fact:idx:${OWNER}`, 0, -1), []);
    const result = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(result.ok, true);
    assert.equal(result.cohortCount, 0);
  });

  it('R10: wired delayed projectors cannot resurrect routing state after hard or physical deletion', async () => {
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');

    async function runDeletionRace(kind) {
      let announceStarted;
      let releaseProjection;
      let announceFinished;
      const started = new Promise((resolve) => {
        announceStarted = resolve;
      });
      const released = new Promise((resolve) => {
        releaseProjection = resolve;
      });
      const finished = new Promise((resolve) => {
        announceFinished = resolve;
      });
      const delayedProjector = {
        async project(snapshot) {
          announceStarted();
          await released;
          try {
            await projection.project(snapshot);
          } finally {
            announceFinished();
          }
        },
      };
      const wiredStore = new storeModule.RedisMessageStore(redis, { routingFactProjection: delayedProjector });
      const now = Date.now();
      const msg = await wiredStore.append({
        provenance: { author: 'user', routed: true, observation: 'original' },
        userId: OWNER,
        catId: null,
        content: '@opus delayed projection',
        mentions: ['opus'],
        timestamp: now,
        threadId: `th-f257-r10-${kind}`,
        routingFact: userBatch(),
      });
      await started;

      if (kind === 'hard') {
        await wiredStore.hardDelete(msg.id, OWNER);
      } else {
        assert.equal(await wiredStore.deleteByThread(msg.threadId), 1);
      }
      releaseProjection();
      await finished;

      assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), null, `${kind} delete stays terminal`);
      assert.equal(await redis.zscore(`routing-fact:proj-errors:${OWNER}`, msg.id), null);
    }

    await runDeletionRace('hard');
    await runDeletionRace('physical');
  });

  it('R10: a delayed reconcile repair cannot resurrect routing state after hard delete', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now);
    await redis.zrem(`routing-fact:idx:${OWNER}`, msg.id);

    const originalRangeByScore = redis.zrangebyscore.bind(redis);
    let announceProjectionRead;
    let releaseProjectionRead;
    const projectionRead = new Promise((resolve) => {
      announceProjectionRead = resolve;
    });
    const projectionRelease = new Promise((resolve) => {
      releaseProjectionRead = resolve;
    });
    redis.zrangebyscore = async (key, ...args) => {
      const result = await originalRangeByScore(key, ...args);
      if (key === `routing-fact:idx:${OWNER}`) {
        announceProjectionRead();
        await projectionRelease;
      }
      return result;
    };

    try {
      const reconcile = projection.reconcileWindow(OWNER, now - 1, now + 1);
      await projectionRead;
      assert.ok(await store.hardDelete(msg.id, OWNER));
      releaseProjectionRead();
      await reconcile;
    } finally {
      redis.zrangebyscore = originalRangeByScore;
    }

    assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), null);
    assert.equal(await redis.zscore(`routing-fact:proj-errors:${OWNER}`, msg.id), null);
  });

  it('R10: physical delete cleans a projection created after its initial sibling scan', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now);
    await redis.del(`routing-fact:idx:${OWNER}`);

    const originalMulti = redis.multi.bind(redis);
    let announceDeleteCommit;
    let releaseDeleteCommit;
    const deleteCommit = new Promise((resolve) => {
      announceDeleteCommit = resolve;
    });
    const deleteRelease = new Promise((resolve) => {
      releaseDeleteCommit = resolve;
    });
    let pauseNextMulti = true;
    redis.multi = (...args) => {
      const transaction = originalMulti(...args);
      if (pauseNextMulti) {
        pauseNextMulti = false;
        const originalExec = transaction.exec.bind(transaction);
        transaction.exec = async () => {
          announceDeleteCommit();
          await deleteRelease;
          return originalExec();
        };
      }
      return transaction;
    };

    try {
      const deletion = store.deleteByThread(msg.threadId);
      await deleteCommit;
      await projection.project(msg);
      assert.ok(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id));
      releaseDeleteCommit();
      assert.equal(await deletion, 1);
    } finally {
      redis.multi = originalMulti;
    }

    assert.equal(await redis.exists(`msg:${msg.id}`), 0);
    assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), null);
  });

  it('R10: hard delete cleans the authority owner that wins a concurrent reassignment', async () => {
    const nextOwner = `${OWNER}-r10-reassigned`;
    const msg = await appendFactMessage(userBatch(), Date.now());

    const originalGetById = store.getById.bind(store);
    let firstRead = true;
    let announceHardRead;
    let releaseHardRead;
    const hardRead = new Promise((resolve) => {
      announceHardRead = resolve;
    });
    const hardRelease = new Promise((resolve) => {
      releaseHardRead = resolve;
    });
    store.getById = async (id) => {
      const value = await originalGetById(id);
      if (firstRead) {
        firstRead = false;
        announceHardRead();
        await hardRelease;
      }
      return value;
    };

    try {
      const hardDelete = store.hardDelete(msg.id, OWNER);
      await hardRead;
      assert.ok(await store.reassignUserId(msg.id, nextOwner));
      const reassigned = await originalGetById(msg.id);
      await projection.project(reassigned);
      assert.ok(await redis.zscore(`routing-fact:idx:${nextOwner}`, msg.id));
      releaseHardRead();
      assert.ok(await hardDelete);
    } finally {
      store.getById = originalGetById;
    }

    assert.equal(await redis.zscore(`routing-fact:idx:${OWNER}`, msg.id), null);
    assert.equal(await redis.zscore(`routing-fact:idx:${nextOwner}`, msg.id), null);
  });

  it('R5: an empty persisted provenance field is malformed, not absent legacy data', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.hset(`msg:${msg.id}`, 'provenance', '');

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false);
    assert.equal(coverage.reason, 'malformed_provenance');
  });

  it('reconcileWindow() removes stale projection members with no authority record', async () => {
    const now = Date.now();
    await redis.zadd(`routing-fact:idx:${OWNER}`, String(now - 100), 'ghost-message-id');
    const result = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(result.ok, true);
    assert.equal(result.removedStale, 1);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1000, now);
    assert.deepEqual(members, []);
  });

  it('computeResolutionRate() aggregates per parserMode per T-A columns, excluding ineligible batches', async () => {
    const now = Date.now();
    // a2a: eligible attempts = resolved + unknown_token (duplicate excluded) → 1/2
    await appendFactMessage(a2aBatch(), now - 900);
    // user: resolved → 1/1
    await appendFactMessage(userBatch(), now - 800);
    // truncated a2a batch (metricEligible=false) — excluded entirely per T-A (右截断)
    await appendFactMessage(a2aBatch({ truncated: true, metricEligible: false }), now - 700);

    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.modes.a2a.numerator, 1);
    assert.equal(result.modes.a2a.denominator, 2);
    assert.equal(result.modes.a2a.rate, 0.5);
    assert.equal(result.modes.a2a.batches, 1);
    assert.equal(result.modes.user.numerator, 1);
    assert.equal(result.modes.user.denominator, 1);
    assert.equal(result.modes.user.rate, 1);
    assert.equal(result.excludedBatches, 1);
    assert.equal(result.malformedFacts, 0);
    assert.equal(result.coverage.authorityCount, 3, 'coverage counts all fact-carrying messages');
  });

  it('computeResolutionRate() reports empty windows as measurable with null rates', async () => {
    const now = Date.now();
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.modes.a2a.rate, null);
    assert.equal(result.modes.user.rate, null);
    assert.equal(result.modes.a2a.denominator, 0);
  });

  it('RedisMessageStore append() drives the wired projector automatically', async () => {
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const wiredStore = new storeModule.RedisMessageStore(redis, { routingFactProjection: projection });
    const now = Date.now();
    const msg = await wiredStore.append({
      provenance: { author: 'user', routed: true, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: '@opus 看下',
      mentions: ['opus'],
      timestamp: now,
      threadId: 'th-f257-wired',
      routingFact: userBatch(),
    });
    // project() is fired void — give the microtask queue a beat
    await new Promise((resolve) => setTimeout(resolve, 50));
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1, now + 1);
    assert.deepEqual(members, [msg.id]);
    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, msg.id);
  });

  it('computeResolutionRate() forces unmeasurable when an authority fact is malformed (sol R1 P1-3)', async () => {
    const now = Date.now();
    await appendFactMessage(a2aBatch(), now - 600);
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.hset(`msg:${msg.id}`, { routingFact: '{broken json' });
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, true, 'no partial rate over a half-parseable window');
    assert.equal(result.reason, 'malformed_authority_fact');
    assert.equal(result.malformedFacts, 1);
  });

  it('deep validation rejects parseable-but-invalid facts (unknown outcome → malformed, sol R1 P1-3)', async () => {
    const now = Date.now();
    const invalid = userBatch({
      attempts: [{ tokenOrdinal: 0, outcome: 'not_a_real_outcome', token: '@x', span: { start: 0, end: 2 } }],
    });
    const msg = await appendFactMessage(invalid, now - 500);
    assert.ok(msg.id);
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, true);
    assert.equal(result.reason, 'malformed_authority_fact');
  });

  it('project() surfaces per-command MULTI errors: no watermark advance, error marker written (sol R1 P1-5)', async () => {
    const now = Date.now();
    // Break the index key type so ZADD fails as a per-command error
    await redis.set(`routing-fact:idx:${OWNER}`, 'wrong-type');
    const msg = await appendFactMessage(userBatch(), now - 100);
    await projection.project(msg);

    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, null, 'watermark must not advance over a failed write');
    const health = await projection.getHealth(OWNER);
    assert.equal(health.errorCount, 1, 'failure lands in the error ZSET (visible)');

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false, 'wrong-type index cannot reconcile silently');
  });
});
