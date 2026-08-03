/**
 * WorkflowSopStore tests (F073 P1)
 * Redis → full suite; no Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';

describe(
  'RedisWorkflowSopStore',
  { skip: !REDIS_URL ? 'REDIS_URL not set' : !REDIS_ISOLATED ? 'Redis isolation flag not set' : false },
  () => {
    let RedisWorkflowSopStore;
    let VersionConflictError;
    let createRedisClient;
    let redis;
    let store;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisWorkflowSopStore');

      const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisWorkflowSopStore.js');
      RedisWorkflowSopStore = storeModule.RedisWorkflowSopStore;
      const portModule = await import('../dist/domains/cats/services/stores/ports/WorkflowSopStore.js');
      VersionConflictError = portModule.VersionConflictError;
      const redisModule = await import('@cat-cafe/shared/utils');
      createRedisClient = redisModule.createRedisClient;

      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        console.warn('[workflow-sop-store.test] Redis unreachable, skipping');
        await redis.quit().catch(() => {});
        return;
      }
      store = new RedisWorkflowSopStore(redis, { ttlSeconds: 60 });
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*', 'managed-work:*']);
        await redis.quit();
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*', 'managed-work:*']);
    });

    it('atomically admits an eligible first-create with an unbound attempt #1', async () => {
      await store.upsert('item-managed-1', 'F275', {}, 'codex-sol', 'owner-1');

      const bundle = await store.getManagedWorkAdmission('owner-1', 'item-managed-1');
      assert.ok(bundle);
      assert.equal(bundle.admission.ownerUserId, 'owner-1');
      assert.equal(bundle.admission.producerKind, 'workflow_sop_v1');
      assert.equal(bundle.admission.producerRef, 'item-managed-1');
      assert.equal(bundle.admission.initialAttemptId, bundle.attempt.attemptId);
      assert.equal(bundle.attempt.workId, bundle.admission.workId);
      assert.equal(bundle.attempt.attemptNumber, 1);
      assert.equal(bundle.attempt.executorCatId, null);
      assert.equal(bundle.attempt.executorBoundAt, null);
    });

    it('returns the same admission identity when the same anchor is replayed', async () => {
      await store.upsert('item-managed-replay', 'F275', {}, 'codex-sol', 'owner-1');
      const first = await store.getManagedWorkAdmission('owner-1', 'item-managed-replay');

      await store.upsert('item-managed-replay', 'F275', { stage: 'impl' }, 'codex-sol', 'owner-1');
      const replayed = await store.getManagedWorkAdmission('owner-1', 'item-managed-replay');

      assert.deepEqual(replayed, first);
    });

    it('does not collapse distinct SOP admission anchors', async () => {
      await store.upsert('item-managed-a', 'F275', {}, 'codex-sol', 'owner-1');
      await store.upsert('item-managed-b', 'F275', {}, 'codex-sol', 'owner-1');

      const left = await store.getManagedWorkAdmission('owner-1', 'item-managed-a');
      const right = await store.getManagedWorkAdmission('owner-1', 'item-managed-b');
      assert.ok(left);
      assert.ok(right);
      assert.notEqual(left.admission.workId, right.admission.workId);
      assert.notEqual(left.attempt.attemptId, right.attempt.attemptId);
    });

    it('does not retro-admit a SOP first-created at completion', async () => {
      await store.upsert('item-managed-complete', 'F275', { stage: 'completion' }, 'codex-sol', 'owner-1');
      assert.equal(await store.getManagedWorkAdmission('owner-1', 'item-managed-complete'), null);

      await store.upsert('item-managed-complete', 'F275', { stage: 'impl' }, 'codex-sol', 'owner-1');
      assert.equal(await store.getManagedWorkAdmission('owner-1', 'item-managed-complete'), null);
    });

    it('fails closed without an authenticated ownerUserId', async () => {
      await assert.rejects(
        () => store.upsert('item-managed-no-owner', 'F275', {}, 'codex-sol'),
        /requires authenticated ownerUserId/,
      );

      assert.deepEqual(await redis.keys('workflow:sop:*'), []);
      assert.deepEqual(await redis.keys('managed-work:*'), []);
    });

    it('concurrent first-create callers converge on one SOP and one admission bundle', async () => {
      const contenderRedis = createRedisClient({ url: REDIS_URL });
      await contenderRedis.ping();
      const contenderStore = new RedisWorkflowSopStore(contenderRedis, { ttlSeconds: 60 });
      let left;
      let right;
      try {
        [left, right] = await Promise.all([
          store.upsert('item-managed-race', 'F275', { batonHolder: 'codex-sol' }, 'codex-sol', 'owner-1'),
          contenderStore.upsert('item-managed-race', 'F275', { batonHolder: 'codex-terra' }, 'codex-terra', 'owner-1'),
        ]);
      } finally {
        await contenderRedis.quit();
      }

      assert.deepEqual(left, right);
      assert.equal(left.version, 1);
      const bundle = await store.getManagedWorkAdmission('owner-1', 'item-managed-race');
      assert.ok(bundle);
      assert.equal(bundle.attempt.attemptNumber, 1);
    });

    it('keeps managed-work identity persistent when the SOP has a test TTL', async () => {
      await store.upsert('item-managed-ttl', 'F275', {}, 'codex-sol', 'owner-1');
      const bundle = await store.getManagedWorkAdmission('owner-1', 'item-managed-ttl');
      assert.ok(bundle);

      assert.equal(await redis.ttl(`managed-work:admission:${bundle.admission.workId}`), -1);
      assert.equal(await redis.ttl(`managed-work:attempt:${bundle.attempt.attemptId}`), -1);
    });

    it('binds attempt #1 to the authenticated executor once and treats the same executor as idempotent', async () => {
      await store.upsert('item-managed-bind', 'F275', {}, 'not-the-executor', 'owner-1');

      const first = await store.bindManagedWorkAttempt('owner-1', 'item-managed-bind', 'codex-sol');
      const replay = await store.bindManagedWorkAttempt('owner-1', 'item-managed-bind', 'codex-sol');

      assert.ok(first);
      assert.equal(first.attempt.executorCatId, 'codex-sol');
      assert.ok(first.attempt.executorBoundAt > 0);
      assert.deepEqual(replay, first);
    });

    it('rejects a different executor after attempt #1 is bound and preserves the first binding', async () => {
      await store.upsert('item-managed-conflict', 'F275', {}, 'not-the-executor', 'owner-1');
      await store.bindManagedWorkAttempt('owner-1', 'item-managed-conflict', 'codex-sol');

      await assert.rejects(
        () => store.bindManagedWorkAttempt('owner-1', 'item-managed-conflict', 'codex-terra'),
        /already bound to codex-sol/,
      );

      const persisted = await store.getManagedWorkAdmission('owner-1', 'item-managed-conflict');
      assert.equal(persisted.attempt.executorCatId, 'codex-sol');
    });

    it('serializes concurrent executor claims so exactly one cat wins attempt #1', async () => {
      await store.upsert('item-managed-bind-race', 'F275', {}, 'not-the-executor', 'owner-1');

      const claims = await Promise.allSettled([
        store.bindManagedWorkAttempt('owner-1', 'item-managed-bind-race', 'codex-sol'),
        store.bindManagedWorkAttempt('owner-1', 'item-managed-bind-race', 'codex-terra'),
      ]);

      assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
      assert.equal(claims.filter((claim) => claim.status === 'rejected').length, 1);
      const persisted = await store.getManagedWorkAdmission('owner-1', 'item-managed-bind-race');
      assert.ok(['codex-sol', 'codex-terra'].includes(persisted.attempt.executorCatId));
    });

    it('does not invent managed identity when an invocation has no admitted anchor', async () => {
      assert.equal(await store.bindManagedWorkAttempt('owner-1', 'item-not-admitted', 'codex-sol'), null);
      assert.deepEqual(await redis.keys('managed-work:*'), []);
    });

    it('get returns null for non-existent item', async () => {
      const result = await store.get('nonexistent');
      assert.equal(result, null);
    });

    it('upsert creates new WorkflowSop with defaults', async () => {
      const sop = await store.upsert('item-1', 'F073', {}, 'opus', 'owner-1');

      assert.equal(sop.featureId, 'F073');
      assert.equal(sop.backlogItemId, 'item-1');
      assert.equal(sop.stage, 'kickoff');
      assert.equal(sop.batonHolder, 'opus');
      assert.equal(sop.nextSkill, null);
      assert.equal(sop.version, 1);
      assert.equal(sop.updatedBy, 'opus');
      assert.deepEqual(sop.resumeCapsule, { goal: '', done: [], currentFocus: '' });
      assert.equal(sop.checks.remoteMainSynced, 'unknown');
      assert.equal(sop.checks.qualityGatePassed, 'unknown');
      assert.equal(sop.checks.reviewApproved, 'unknown');
      assert.equal(sop.checks.visionGuardDone, 'unknown');
      assert.ok(sop.updatedAt > 0);
    });

    it('upsert creates with explicit values', async () => {
      const sop = await store.upsert(
        'item-2',
        'F073',
        {
          stage: 'impl',
          batonHolder: 'codex',
          nextSkill: 'tdd',
          resumeCapsule: { goal: 'Build store', done: ['types'], currentFocus: 'Redis impl' },
          checks: { remoteMainSynced: 'attested' },
        },
        'opus',
        'owner-1',
      );

      assert.equal(sop.stage, 'impl');
      assert.equal(sop.batonHolder, 'codex');
      assert.equal(sop.nextSkill, 'tdd');
      assert.equal(sop.resumeCapsule.goal, 'Build store');
      assert.deepEqual(sop.resumeCapsule.done, ['types']);
      assert.equal(sop.resumeCapsule.currentFocus, 'Redis impl');
      assert.equal(sop.checks.remoteMainSynced, 'attested');
      assert.equal(sop.checks.qualityGatePassed, 'unknown');
    });

    it('get retrieves persisted WorkflowSop', async () => {
      await store.upsert('item-3', 'F073', { stage: 'review' }, 'opus', 'owner-1');
      const result = await store.get('item-3');

      assert.notEqual(result, null);
      assert.equal(result.featureId, 'F073');
      assert.equal(result.stage, 'review');
      assert.equal(result.version, 1);
    });

    it('upsert merges partial updates into existing record', async () => {
      await store.upsert(
        'item-4',
        'F073',
        {
          stage: 'impl',
          batonHolder: 'opus',
          resumeCapsule: { goal: 'Build feature' },
        },
        'opus',
        'owner-1',
      );

      const updated = await store.upsert(
        'item-4',
        'F073',
        {
          stage: 'review',
          batonHolder: 'codex',
          resumeCapsule: { currentFocus: 'Review code' },
        },
        'codex',
        'owner-1',
      );

      assert.equal(updated.stage, 'review');
      assert.equal(updated.batonHolder, 'codex');
      assert.equal(updated.version, 2);
      assert.equal(updated.updatedBy, 'codex');
      // Merged: goal preserved, currentFocus updated
      assert.equal(updated.resumeCapsule.goal, 'Build feature');
      assert.equal(updated.resumeCapsule.currentFocus, 'Review code');
    });

    it('upsert increments version on each update', async () => {
      await store.upsert('item-5', 'F073', {}, 'opus', 'owner-1');
      await store.upsert('item-5', 'F073', { stage: 'impl' }, 'opus', 'owner-1');
      const sop = await store.upsert('item-5', 'F073', { stage: 'review' }, 'codex', 'owner-1');

      assert.equal(sop.version, 3);
    });

    it('upsert with CAS succeeds when version matches', async () => {
      await store.upsert('item-6', 'F073', {}, 'opus', 'owner-1');
      const updated = await store.upsert(
        'item-6',
        'F073',
        {
          stage: 'impl',
          expectedVersion: 1,
        },
        'opus',
        'owner-1',
      );

      assert.equal(updated.version, 2);
      assert.equal(updated.stage, 'impl');
    });

    it('upsert with CAS throws VersionConflictError on mismatch', async () => {
      await store.upsert('item-7', 'F073', {}, 'opus', 'owner-1');
      await store.upsert('item-7', 'F073', { stage: 'impl' }, 'opus', 'owner-1'); // version = 2

      await assert.rejects(
        () =>
          store.upsert(
            'item-7',
            'F073',
            {
              stage: 'review',
              expectedVersion: 1, // stale
            },
            'codex',
            'owner-1',
          ),
        (err) => {
          assert.ok(err instanceof VersionConflictError);
          assert.equal(err.currentState.version, 2);
          assert.equal(err.currentState.stage, 'impl');
          return true;
        },
      );
    });

    it('upsert without expectedVersion skips CAS check', async () => {
      await store.upsert('item-8', 'F073', {}, 'opus', 'owner-1');
      await store.upsert('item-8', 'F073', { stage: 'impl' }, 'opus', 'owner-1');

      // No expectedVersion — should succeed regardless
      const updated = await store.upsert('item-8', 'F073', { stage: 'review' }, 'codex', 'owner-1');
      assert.equal(updated.version, 3);
      assert.equal(updated.stage, 'review');
    });

    it('upsert can set nextSkill to null explicitly', async () => {
      await store.upsert('item-9', 'F073', { nextSkill: 'tdd' }, 'opus', 'owner-1');
      const updated = await store.upsert('item-9', 'F073', { nextSkill: null }, 'opus', 'owner-1');

      assert.equal(updated.nextSkill, null);
    });

    it('delete removes existing record', async () => {
      await store.upsert('item-10', 'F073', {}, 'opus', 'owner-1');
      const deleted = await store.delete('item-10');
      assert.equal(deleted, true);

      const result = await store.get('item-10');
      assert.equal(result, null);
    });

    it('delete returns false for non-existent record', async () => {
      const deleted = await store.delete('nonexistent');
      assert.equal(deleted, false);
    });
  },
);
