/**
 * F260 R4: RedisEntityProposalStore dedup contract tests.
 * Runs against a real Redis instance (pnpm test:redis).
 * Without REDIS_URL → tests are skipped.
 *
 * Pins the three dedup methods (getDedupProposalId, reserveDedup, releaseDedup)
 * against real Redis SET NX EX / conditional DEL behavior — InMemory store
 * cannot verify TTL expiry or atomic conditional delete semantics.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe(
  'RedisEntityProposalStore — dedup contract (real Redis)',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let RedisEntityProposalStore;
    let createRedisClient;
    let redis;
    let store;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisEntityProposalStore-dedup');

      const storeModule = await import('../../dist/domains/approval-hub/stores/redis/RedisEntityProposalStore.js');
      RedisEntityProposalStore = storeModule.RedisEntityProposalStore;
      const redisModule = await import('@cat-cafe/shared/utils');
      createRedisClient = redisModule.createRedisClient;

      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        console.warn('[redis-entity-dedup.test] Redis unreachable, skipping');
        await redis.quit().catch(() => {});
        return;
      }
      store = new RedisEntityProposalStore(redis);
    });

    afterEach(async () => {
      if (connected) {
        await cleanupPrefixedRedisKeys(redis, [
          'entity-proposal:*',
          'entity-proposal-user-pending:*',
          'entity-proposal-user-settled:*',
          'entity-proposal-dedup:*',
          'entity-proposal-counter',
        ]);
      }
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, [
          'entity-proposal:*',
          'entity-proposal-user-pending:*',
          'entity-proposal-user-settled:*',
          'entity-proposal-dedup:*',
          'entity-proposal-counter',
        ]);
        await redis.quit().catch(() => {});
      }
    });

    it('reserveDedup: first caller wins, second gets winner ID', async () => {
      if (!connected) return;

      const winner = await store.reserveDedup('user-1', 'req-abc', 'ep-first');
      assert.equal(winner, 'ep-first', 'first caller must win');

      const loser = await store.reserveDedup('user-1', 'req-abc', 'ep-second');
      assert.equal(loser, 'ep-first', 'second caller must get the winner ID');
    });

    it('getDedupProposalId: returns winner after reservation', async () => {
      if (!connected) return;

      const before = await store.getDedupProposalId('user-1', 'req-lookup');
      assert.equal(before, null, 'no reservation yet');

      await store.reserveDedup('user-1', 'req-lookup', 'ep-winner');
      const after = await store.getDedupProposalId('user-1', 'req-lookup');
      assert.equal(after, 'ep-winner');
    });

    it('releaseDedup: correct ID releases, wrong ID is no-op', async () => {
      if (!connected) return;

      await store.reserveDedup('user-1', 'req-release', 'ep-owner');

      // Wrong ID: no-op
      await store.releaseDedup('user-1', 'req-release', 'ep-imposter');
      const stillThere = await store.getDedupProposalId('user-1', 'req-release');
      assert.equal(stillThere, 'ep-owner', 'wrong-id release must be no-op');

      // Correct ID: deletes
      await store.releaseDedup('user-1', 'req-release', 'ep-owner');
      const gone = await store.getDedupProposalId('user-1', 'req-release');
      assert.equal(gone, null, 'correct-id release must delete');
    });

    it('releaseDedup then retry: released slot can be re-reserved', async () => {
      if (!connected) return;

      await store.reserveDedup('user-1', 'req-retry', 'ep-attempt-1');
      await store.releaseDedup('user-1', 'req-retry', 'ep-attempt-1');

      // Retry after release gets a new reservation
      const retryWinner = await store.reserveDedup('user-1', 'req-retry', 'ep-attempt-2');
      assert.equal(retryWinner, 'ep-attempt-2', 'released slot must allow new reservation');
    });

    it('different users do not collide on the same clientRequestId', async () => {
      if (!connected) return;

      const a = await store.reserveDedup('user-A', 'req-shared', 'ep-A');
      const b = await store.reserveDedup('user-B', 'req-shared', 'ep-B');

      assert.equal(a, 'ep-A');
      assert.equal(b, 'ep-B', 'different users must have independent dedup namespaces');
    });

    it('create promotes the winning reservation to a persistent retry identity', async () => {
      if (!connected) return;

      const userId = 'user-persistent';
      const clientRequestId = 'req-persistent';
      const proposalId = 'ep-persistent';
      await store.reserveDedup(userId, clientRequestId, proposalId);

      const reservationTtl = await redis.ttl(`entity-proposal-dedup:${userId}::${clientRequestId}`);
      assert.ok(reservationTtl > 0, 'pre-create reservation must remain crash-recoverable via a bounded TTL');

      await store.create({
        proposalId,
        clientRequestId,
        entityId: 'concept:persistent-retry',
        entityType: 'concept',
        canonicalName: 'Persistent retry',
        aliases: ['persistent-retry'],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        provenance: [{ source: 'redis-contract' }],
        rationale: 'Publication recovery must keep the original canonical proposal identity.',
        sourceThreadId: 'thread-persistent',
        sourceCatId: 'codex-sol',
        ownerUserId: userId,
      });

      assert.equal(
        await redis.ttl(`entity-proposal-dedup:${userId}::${clientRequestId}`),
        -1,
        'persisted proposal retry identity must not expire',
      );
      assert.equal(await store.getDedupProposalId(userId, clientRequestId), proposalId);

      await store.abortStaged(proposalId, 'test-cleanup');
      assert.equal(await store.get(proposalId), null, 'staged proposal must be removed');
      assert.equal(
        await store.getDedupProposalId(userId, clientRequestId),
        null,
        'abort must atomically release its persistent retry identity',
      );
    });
  },
);
