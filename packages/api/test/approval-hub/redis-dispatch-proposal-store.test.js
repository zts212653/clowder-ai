/**
 * F246 Phase B: RedisDispatchProposalStore tests.
 * Runs against a real Redis instance (pnpm test:redis).
 * Without REDIS_URL → tests are skipped.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisDispatchProposalStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisDispatchProposalStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisDispatchProposalStore');

    const storeModule = await import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js');
    RedisDispatchProposalStore = storeModule.RedisDispatchProposalStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-dispatch-proposal-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisDispatchProposalStore(redis);
  });

  afterEach(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis, [
        'dispatch-proposal:*',
        'dispatch-proposal-user-pending:*',
        'dispatch-proposal-clientmsg:*',
      ]);
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, [
        'dispatch-proposal:*',
        'dispatch-proposal-user-pending:*',
        'dispatch-proposal-clientmsg:*',
      ]);
      await redis.quit();
    }
  });

  const baseInput = {
    proposalId: 'dp-redis-001',
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Fix the bug in package X',
    targetCats: ['sonnet'],
    createdAt: Date.now(),
  };

  // --- create ---

  it('create → stores proposal with status=pending', async () => {
    const proposal = await store.create(baseInput);
    assert.equal(proposal.proposalId, 'dp-redis-001');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.effectClass, 'assign_work');
    assert.equal(proposal.content, 'Fix the bug in package X');
    assert.deepEqual(proposal.targetCats, ['sonnet']);
  });

  // --- get ---

  it('get → retrieves by proposalId', async () => {
    await store.create(baseInput);
    const fetched = await store.get('dp-redis-001');
    assert.ok(fetched);
    assert.equal(fetched.proposalId, 'dp-redis-001');
    assert.equal(fetched.content, 'Fix the bug in package X');
    assert.deepEqual(fetched.targetCats, ['sonnet']);
  });

  it('get → returns null for nonexistent', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  // --- listPendingByUser ---

  it('listPendingByUser → returns pending for userId, newest first', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-older', createdAt: 1000 });
    await store.create({ ...baseInput, proposalId: 'dp-newer', createdAt: 2000 });
    const list = await store.listPendingByUser('user-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].proposalId, 'dp-newer');
    assert.equal(list[1].proposalId, 'dp-older');
  });

  it('listPendingByUser → excludes approved/rejected', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-pending' });
    await store.create({ ...baseInput, proposalId: 'dp-approved' });
    await store.create({ ...baseInput, proposalId: 'dp-rejected' });
    await store.approve('dp-approved', 'user-1');
    await store.reject('dp-rejected', 'user-1');

    const list = await store.listPendingByUser('user-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].proposalId, 'dp-pending');
  });

  // --- approve ---

  it('approve → CAS pending → approved (no deliveredMessageId yet)', async () => {
    await store.create(baseInput);
    const result = await store.approve('dp-redis-001', 'user-1');
    assert.ok(result);
    assert.equal(result.status, 'approved');
    assert.equal(result.deliveredMessageId, undefined, 'deliveredMessageId not set until recordDelivery');
    assert.equal(result.decidedBy, 'user-1');
    assert.ok(result.decidedAt > 0);
  });

  it('approve → non-pending returns null (INV-2)', async () => {
    await store.create(baseInput);
    await store.approve('dp-redis-001', 'user-1');
    const secondApprove = await store.approve('dp-redis-001', 'user-1');
    assert.equal(secondApprove, null);
  });

  it('approve → removes from pending index', async () => {
    await store.create(baseInput);
    await store.approve('dp-redis-001', 'user-1');
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 0);
  });

  it('recordDelivery → sets deliveredMessageId after approve', async () => {
    await store.create(baseInput);
    await store.approve('dp-redis-001', 'user-1');
    await store.recordDelivery('dp-redis-001', 'msg-delivered-456');
    const fetched = await store.get('dp-redis-001');
    assert.ok(fetched);
    assert.equal(fetched.deliveredMessageId, 'msg-delivered-456');
    assert.equal(fetched.status, 'approved');
  });

  // --- reject ---

  it('reject → CAS pending → rejected', async () => {
    await store.create(baseInput);
    const result = await store.reject('dp-redis-001', 'user-1');
    assert.ok(result);
    assert.equal(result.status, 'rejected');
    assert.equal(result.decidedBy, 'user-1');
    assert.ok(result.decidedAt > 0);
  });

  it('reject → non-pending returns null (INV-2)', async () => {
    await store.create(baseInput);
    await store.reject('dp-redis-001', 'user-1');
    const secondReject = await store.reject('dp-redis-001', 'user-1');
    assert.equal(secondReject, null);
  });

  // --- findByClientMessageId ---

  it('findByClientMessageId → idempotency lookup', async () => {
    await store.create({ ...baseInput, clientMessageId: 'client-key-1' });
    const found = await store.findByClientMessageId('client-key-1', 'thread-sender');
    assert.ok(found);
    assert.equal(found.proposalId, 'dp-redis-001');
  });

  it('findByClientMessageId → returns null for unknown', async () => {
    const result = await store.findByClientMessageId('nonexistent', 'thread-sender');
    assert.equal(result, null);
  });

  // --- CAS race scenarios ---

  it('approve+reject race → first CAS wins', async () => {
    await store.create(baseInput);
    const approved = await store.approve('dp-redis-001', 'user-1');
    const rejected = await store.reject('dp-redis-001', 'user-1');
    assert.ok(approved);
    assert.equal(rejected, null);
  });

  it('double approve → second returns null (INV-5)', async () => {
    await store.create(baseInput);
    const first = await store.approve('dp-redis-001', 'user-1');
    const second = await store.approve('dp-redis-001', 'user-1');
    assert.ok(first);
    assert.equal(second, null);
  });

  it('recordDelivery after approve → persisted on get', async () => {
    await store.create(baseInput);
    await store.approve('dp-redis-001', 'user-1');
    await store.recordDelivery('dp-redis-001', 'msg-final');
    const persisted = await store.get('dp-redis-001');
    assert.equal(persisted.deliveredMessageId, 'msg-final');
    assert.equal(persisted.status, 'approved');
  });

  // --- Optional fields round-trip ---

  it('round-trips optional fields (replyTo, cardMessageId)', async () => {
    await store.create({
      ...baseInput,
      proposalId: 'dp-optional',
      replyTo: 'msg-parent',
      cardMessageId: 'card-123',
      clientMessageId: 'dedup-key',
    });
    const fetched = await store.get('dp-optional');
    assert.equal(fetched.replyTo, 'msg-parent');
    assert.equal(fetched.cardMessageId, 'card-123');
    assert.equal(fetched.clientMessageId, 'dedup-key');
  });
});
