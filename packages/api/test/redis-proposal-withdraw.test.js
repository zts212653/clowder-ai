// @ts-check
/** F128 Redis requester withdrawal — atomic status + pending projection + audit hydration. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const PREFIXES = ['proposal:*', 'proposals:*', 'dedup:propose:*'];

describe('RedisProposalStore requester withdraw', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisProposalStore requester withdraw');
    const { RedisProposalStore } = await import('../dist/domains/cats/services/stores/redis/RedisProposalStore.js');
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
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, PREFIXES);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, PREFIXES);
  });

  it('atomically withdraws pending and rehydrates the audit outside the pending projection', async () => {
    const proposal = await store.create({
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      sourceMessageId: 'msg_1',
      title: 'Mistaken split',
      reason: 'Requester should retract it',
      parentThreadId: 'thread_src',
      preferredCats: [],
      projectPath: '/projects/cat-cafe',
      createdBy: 'alice',
    });

    const withdrawn = await store.withdrawPending({ proposalId: proposal.proposalId, withdrawnBy: 'opus' });

    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal(withdrawn.withdrawnBy, 'opus');
    assert.ok(Number.isFinite(withdrawn.withdrawnAt));
    const hydrated = await store.get(proposal.proposalId);
    assert.equal(hydrated.status, 'withdrawn');
    assert.equal(hydrated.withdrawnBy, 'opus');
    assert.equal(hydrated.withdrawnAt, withdrawn.withdrawnAt);
    assert.deepEqual(await store.listPending('alice'), []);
  });

  it('lets exactly one of approve claim and requester withdraw win', async () => {
    const proposal = await store.create({
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_2',
      sourceCatId: 'opus',
      sourceMessageId: 'msg_2',
      title: 'Race',
      reason: 'Atomic winner',
      parentThreadId: 'thread_src',
      preferredCats: [],
      projectPath: '/projects/cat-cafe',
      createdBy: 'alice',
    });

    const [claim, withdraw] = await Promise.all([
      store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'alice' }),
      store.withdrawPending({ proposalId: proposal.proposalId, withdrawnBy: 'opus' }),
    ]);

    assert.equal(Number(Boolean(claim)) + Number(Boolean(withdraw)), 1);
    const hydrated = await store.get(proposal.proposalId);
    assert.equal(hydrated.status, claim ? 'approving' : 'withdrawn');
  });
});
