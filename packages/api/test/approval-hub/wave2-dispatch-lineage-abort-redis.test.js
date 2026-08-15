import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisDispatchProposalStore lineage abort recovery', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisDispatchProposalStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisDispatchProposalStore lineage abort recovery');

    const storeModule = await import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js');
    RedisDispatchProposalStore = storeModule.RedisDispatchProposalStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[wave2-dispatch-lineage-abort-redis.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisDispatchProposalStore(redis);
  });

  afterEach(async () => {
    if (connected) await cleanupDispatchKeys();
  });

  after(async () => {
    if (redis && connected) {
      await cleanupDispatchKeys();
      await redis.quit();
    }
  });

  async function cleanupDispatchKeys() {
    await cleanupPrefixedRedisKeys(redis, [
      'dispatch-proposal:*',
      'dispatch-proposal-user-pending:*',
      'dispatch-proposal-user-settled:*',
      'dispatch-proposal-clientmsg:*',
      'dispatch-proposal-lineage:*',
      'dispatch-proposal-canonical-admission:*',
      'dispatch-proposal-canonical-admission-rebuild-completed-at',
    ]);
  }

  const baseInput = {
    proposalId: 'dp-lineage-a',
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Fix the bug in package X',
    targetCats: ['sonnet'],
    createdAt: 1_000,
  };

  async function anchor(proposalId) {
    const proposal = await store.get(proposalId);
    await store.commitEnvelope(proposalId, {
      canonicalProposalId: proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      originRef: { kind: 'event', anchor: `test:${proposalId}`, summary: 'test', threadId: proposal.sourceThreadId },
      approvalCardRef: { threadId: proposal.sourceThreadId, messageId: `card-${proposalId}` },
      createdAt: proposal.createdAt,
    });
  }

  it('does not supersede a lineage holder while its publication is staged', async () => {
    const first = await store.create(baseInput);
    const overlapping = await store.create({
      ...baseInput,
      proposalId: 'dp-lineage-overlap',
      clientMessageId: 'lineage-overlap',
      createdAt: 2_000,
    });

    assert.equal(overlapping.proposal.proposalId, first.proposal.proposalId);
    assert.equal(await store.get('dp-lineage-overlap'), null);
    assert.equal((await store.get(baseInput.proposalId)).status, 'pending');
  });

  it('does not let an aborted staged successor hide an approved predecessor during delivery rollback', async () => {
    await store.create(baseInput);
    const approved = await store.approve('dp-lineage-a', 'user-1');
    assert.equal(approved.status, 'approved');

    await store.create({
      ...baseInput,
      proposalId: 'dp-lineage-b',
      content: 'Replacement before card append',
      createdAt: 2_000,
    });

    const lineageKey = `dispatch-proposal-lineage:${baseInput.sourceThreadId}:${baseInput.targetThreadId}:${baseInput.senderCatId}`;
    assert.equal(await redis.get(lineageKey), 'dp-lineage-b');

    await store.abortStaged('dp-lineage-b', 'pre-card failure');
    assert.equal(await store.get('dp-lineage-b'), null);

    const reverted = await store.revertToPending('dp-lineage-a');
    assert.ok(reverted, 'approved predecessor must be restored when the successor was aborted');
    assert.equal(reverted.status, 'pending');
    assert.equal(await redis.get(lineageKey), 'dp-lineage-a');

    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.deepEqual(
      pending.map((proposal) => proposal.proposalId),
      ['dp-lineage-a'],
    );
  });

  it('restores an anchored predecessor across sequential failed successors', async () => {
    const first = await store.create(baseInput);
    assert.equal(first.proposal.status, 'pending');
    await anchor(first.proposal.proposalId);

    const second = await store.create({
      ...baseInput,
      proposalId: 'dp-lineage-b',
      content: 'First replacement before card append',
      createdAt: 2_000,
    });
    assert.deepEqual(
      second.supersededProposals.map((proposal) => proposal.proposalId),
      ['dp-lineage-a'],
    );

    await store.abortStaged('dp-lineage-b', 'pre-card failure');

    await store.create({
      ...baseInput,
      proposalId: 'dp-lineage-c',
      content: 'Second replacement before first rollback restores',
      createdAt: 3_000,
    });

    await store.abortStaged('dp-lineage-c', 'pre-card failure');

    const lineageKey = `dispatch-proposal-lineage:${baseInput.sourceThreadId}:${baseInput.targetThreadId}:${baseInput.senderCatId}`;
    const restored = await store.get('dp-lineage-a');
    assert.equal(restored.status, 'pending');
    assert.equal(restored.supersededBy, undefined);
    assert.equal(await redis.get(lineageKey), 'dp-lineage-a');

    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.deepEqual(
      pending.map((proposal) => proposal.proposalId),
      ['dp-lineage-a'],
    );
  });
});
