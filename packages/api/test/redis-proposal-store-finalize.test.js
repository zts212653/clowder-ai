// @ts-check
/**
 * F128 RedisProposalStore.finalizeApproval — projectPath audit sync (Redis-backed).
 *
 * Pins the Redis-only contract the in-memory store cannot surface
 * (feedback_inmemory_store_tests_miss_redis_behavior): an approve-time projectPath override
 * must be HSET during finalize, so a FRESH get() — re-hydrated from the hash — returns the
 * re-homed ownership, not the create-time value. The in-memory store mutates the record in
 * place and would pass even if finalizedFields forgot to write projectPath; only a real
 * round-trip through Redis catches a missing HSET.
 *
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe(
  'RedisProposalStore.finalizeApproval — projectPath audit sync (F128)',
  {
    skip: redisIsolationSkipReason(REDIS_URL),
  },
  () => {
    let RedisProposalStore;
    let redis;
    let store;
    let connected = false;

    function baseInput(overrides = {}) {
      return {
        sourceThreadId: 'thread_src',
        sourceInvocationId: 'inv_1',
        sourceCatId: 'opus',
        sourceMessageId: 'msg-origin-1',
        title: 'rehome',
        reason: 'F128 projectPath finalize',
        parentThreadId: 'thread_src',
        preferredCats: [],
        projectPath: '/projects/orig',
        createdBy: 'alice',
        ...overrides,
      };
    }

    const PREFIXES = ['proposal:*', 'proposals:*', 'dedup:propose:*'];

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisProposalStore');
      const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisProposalStore.js');
      RedisProposalStore = storeModule.RedisProposalStore;
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      store = new RedisProposalStore(redis);
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, PREFIXES);
        await redis.quit();
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, PREFIXES);
    });

    it('persists approved/rejected/withdrawn owner history atomically and reopens it in a fresh store', async () => {
      const approved = await store.create(baseInput());
      await store.claimForApproval({ proposalId: approved.proposalId, approvedBy: 'alice' });
      await store.finalizeApproval({ proposalId: approved.proposalId, createdThreadId: 'history-child' });
      const rejected = await store.create(baseInput());
      await store.markRejected({ proposalId: rejected.proposalId, rejectedBy: 'alice' });
      const withdrawn = await store.create(baseInput());
      await store.withdrawPending({ proposalId: withdrawn.proposalId, withdrawnBy: 'opus' });
      const fresh = new RedisProposalStore(redis);
      assert.deepEqual((await fresh.listSettledByUser('alice')).map((p) => p.status).sort(), [
        'approved',
        'rejected',
        'withdrawn',
      ]);
      assert.equal((await fresh.listSettledByUser('alice', 1)).length, 1);
      assert.deepEqual(await fresh.listSettledByUser('foreign'), []);
      assert.equal(await redis.zcard('proposals:settled:alice'), 3);
      assert.equal(await redis.pttl('proposals:settled:alice'), -1);
    });

    it('hard-deletes the newest settled member without hiding the next result behind limit one', async () => {
      const older = await store.create(baseInput());
      await store.markRejected({ proposalId: older.proposalId, rejectedBy: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await store.create(baseInput());
      await store.markRejected({ proposalId: newer.proposalId, rejectedBy: 'alice' });
      assert.equal((await store.listSettledByUser('alice', 1))[0].proposalId, newer.proposalId);
      await store.delete(newer.proposalId);
      assert.equal(await redis.zscore('proposals:settled:alice', newer.proposalId), null);
      assert.equal((await store.listSettledByUser('alice', 1))[0]?.proposalId, older.proposalId);
    });

    it('refuses an invalid settled index before changing either proposal or decision state', async () => {
      const proposal = await store.create(baseInput());
      await redis.set('proposals:settled:alice', 'invalid-type');
      const before = await store.get(proposal.proposalId);
      await assert.rejects(
        store.withdrawPending({ proposalId: proposal.proposalId, withdrawnBy: 'opus' }),
        /type conflict/,
      );
      assert.deepEqual(await store.get(proposal.proposalId), before);
      await assert.rejects(
        store.markRejected({ proposalId: proposal.proposalId, rejectedBy: 'alice' }),
        /type conflict/,
      );
      assert.deepEqual(await store.get(proposal.proposalId), before);
    });

    it('override.projectPath is persisted on finalize → fresh get() hydrates the re-homed path', async () => {
      const created = await store.create(baseInput());
      assert.equal(created.projectPath, '/projects/orig');

      const claimed = await store.claimForApproval({ proposalId: created.proposalId, approvedBy: 'alice' });
      assert.ok(claimed, 'claim pending → approving should succeed');

      const finalized = await store.finalizeApproval({
        proposalId: created.proposalId,
        createdThreadId: 'thread_child',
        overrides: { projectPath: '/projects/rehomed' },
      });
      assert.ok(finalized, 'finalize should succeed');
      assert.equal(finalized.projectPath, '/projects/rehomed', 'returned snapshot reflects the override');

      // The faithful check: re-hydrate from Redis. Without finalizedFields persisting
      // projectPath this returns the stale '/projects/orig'.
      const fresh = await store.get(created.proposalId);
      assert.ok(fresh);
      assert.equal(fresh.sourceMessageId, 'msg-origin-1');
      assert.equal(fresh.projectPath, '/projects/rehomed', 'persisted hash must carry the re-homed ownership');
      assert.equal(fresh.status, 'approved');
    });

    it('finalize without a projectPath override keeps the create-time ownership (idempotent)', async () => {
      const created = await store.create(baseInput({ projectPath: '/projects/keep' }));
      await store.claimForApproval({ proposalId: created.proposalId, approvedBy: 'alice' });

      await store.finalizeApproval({
        proposalId: created.proposalId,
        createdThreadId: 'thread_child2',
        overrides: { title: 'edited title' },
      });

      const fresh = await store.get(created.proposalId);
      assert.ok(fresh);
      assert.equal(fresh.projectPath, '/projects/keep', 'no override → projectPath unchanged');
      assert.equal(fresh.title, 'edited title', 'other overrides still apply');
    });

    it('override.reportingMode is persisted on finalize → fresh get() hydrates the approved contract', async () => {
      const created = await store.create(baseInput({ reportingMode: 'final-only' }));
      await store.claimForApproval({ proposalId: created.proposalId, approvedBy: 'alice' });

      const finalized = await store.finalizeApproval({
        proposalId: created.proposalId,
        createdThreadId: 'thread_child3',
        overrides: { reportingMode: 'none' },
      });
      assert.ok(finalized, 'finalize should succeed');
      assert.equal(finalized.reportingMode, 'none', 'returned snapshot reflects the override');

      const fresh = await store.get(created.proposalId);
      assert.ok(fresh);
      assert.equal(fresh.reportingMode, 'none', 'persisted hash must carry the final reportingMode');
    });

    it('recordCreatedThread checkpoints reportingMode override before stale recovery', async () => {
      const created = await store.create(baseInput({ reportingMode: 'final-only' }));
      await store.claimForApproval({ proposalId: created.proposalId, approvedBy: 'alice' });

      await store.recordCreatedThread(created.proposalId, 'thread_child4', { reportingMode: 'none' });

      const fresh = await store.get(created.proposalId);
      assert.ok(fresh);
      assert.equal(fresh.status, 'approving', 'checkpoint must not finalize the proposal');
      assert.equal(fresh.createdThreadId, 'thread_child4', 'checkpoint must persist the created thread id');
      assert.equal(fresh.reportingMode, 'none', 'checkpoint must carry the final reportingMode across crashes');
    });
  },
);
