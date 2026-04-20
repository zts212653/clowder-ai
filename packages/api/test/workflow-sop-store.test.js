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
        await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*']);
        await redis.quit();
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*']);
    });

    it('get returns null for non-existent item', async () => {
      const result = await store.get('nonexistent');
      assert.equal(result, null);
    });

    it('upsert creates new WorkflowSop with defaults', async () => {
      const sop = await store.upsert('item-1', 'F073', {}, 'opus');

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
      await store.upsert('item-3', 'F073', { stage: 'review' }, 'opus');
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
      await store.upsert('item-5', 'F073', {}, 'opus');
      await store.upsert('item-5', 'F073', { stage: 'impl' }, 'opus');
      const sop = await store.upsert('item-5', 'F073', { stage: 'review' }, 'codex');

      assert.equal(sop.version, 3);
    });

    it('upsert with CAS succeeds when version matches', async () => {
      await store.upsert('item-6', 'F073', {}, 'opus');
      const updated = await store.upsert(
        'item-6',
        'F073',
        {
          stage: 'impl',
          expectedVersion: 1,
        },
        'opus',
      );

      assert.equal(updated.version, 2);
      assert.equal(updated.stage, 'impl');
    });

    it('upsert with CAS throws VersionConflictError on mismatch', async () => {
      await store.upsert('item-7', 'F073', {}, 'opus');
      await store.upsert('item-7', 'F073', { stage: 'impl' }, 'opus'); // version = 2

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
      await store.upsert('item-8', 'F073', {}, 'opus');
      await store.upsert('item-8', 'F073', { stage: 'impl' }, 'opus');

      // No expectedVersion — should succeed regardless
      const updated = await store.upsert('item-8', 'F073', { stage: 'review' }, 'codex');
      assert.equal(updated.version, 3);
      assert.equal(updated.stage, 'review');
    });

    it('upsert can set nextSkill to null explicitly', async () => {
      await store.upsert('item-9', 'F073', { nextSkill: 'tdd' }, 'opus');
      const updated = await store.upsert('item-9', 'F073', { nextSkill: null }, 'opus');

      assert.equal(updated.nextSkill, null);
    });

    it('delete removes existing record', async () => {
      await store.upsert('item-10', 'F073', {}, 'opus');
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
