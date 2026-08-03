/**
 * F246 Phase B/J: RedisDispatchProposalStore tests.
 * Runs against a real Redis instance (pnpm test:redis).
 * Without REDIS_URL → tests are skipped.
 *
 * Phase J additions: lineage-based supersede, revertToPending lineage guard.
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
        'dispatch-proposal-user-settled:*',
        'dispatch-proposal-clientmsg:*',
        'dispatch-proposal-lineage:*',
      ]);
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, [
        'dispatch-proposal:*',
        'dispatch-proposal-user-pending:*',
        'dispatch-proposal-user-settled:*',
        'dispatch-proposal-clientmsg:*',
        'dispatch-proposal-lineage:*',
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

  // --- create (Phase J: CreateDispatchProposalResult) ---

  it('create → returns { proposal, supersededProposals } shape', async () => {
    const result = await store.create(baseInput);
    assert.ok(result.proposal, 'result.proposal must exist');
    assert.ok(Array.isArray(result.supersededProposals), 'result.supersededProposals must be array');
    assert.equal(result.proposal.proposalId, 'dp-redis-001');
    assert.equal(result.proposal.status, 'pending');
    assert.equal(result.proposal.effectClass, 'assign_work');
    assert.equal(result.proposal.content, 'Fix the bug in package X');
    assert.deepEqual(result.proposal.targetCats, ['sonnet']);
    assert.equal(result.supersededProposals.length, 0);
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
    // Different K (different targetThreadId) so second create doesn't supersede first
    await store.create({ ...baseInput, proposalId: 'dp-older', targetThreadId: 'thread-t1', createdAt: 1000 });
    await store.create({ ...baseInput, proposalId: 'dp-newer', targetThreadId: 'thread-t2', createdAt: 2000 });
    const list = await store.listPendingByUser('user-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].proposalId, 'dp-newer');
    assert.equal(list[1].proposalId, 'dp-older');
  });

  it('listPendingByUser → excludes approved/rejected', async () => {
    // Different K for each so they don't supersede each other
    await store.create({ ...baseInput, proposalId: 'dp-pending', targetThreadId: 'thread-t1' });
    await store.create({ ...baseInput, proposalId: 'dp-approved', targetThreadId: 'thread-t2' });
    await store.create({ ...baseInput, proposalId: 'dp-rejected', targetThreadId: 'thread-t3' });
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

  it('approve persists private owner provenance without exposing it in the proposal projection', async () => {
    await store.create(baseInput);
    await store.approve('dp-redis-001', 'user-1', 'strict');

    assert.equal(await store.getApprovalOwnerAuthProvenance('dp-redis-001'), 'strict');
    const fetched = await store.get('dp-redis-001');
    assert.equal(Object.hasOwn(fetched, 'ownerAuthProvenance'), false);
    assert.equal(Object.hasOwn(fetched, 'approvalOwnerAuthProvenance'), false);
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

  // --- listSettledByUser ---

  it('listSettledByUser → returns approved/rejected newest first', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-s1', targetThreadId: 'thread-t1' });
    await store.create({ ...baseInput, proposalId: 'dp-s2', targetThreadId: 'thread-t2' });
    await store.approve('dp-s1', 'user-1');
    await store.reject('dp-s2', 'user-1');

    const settled = await store.listSettledByUser('user-1', 10);
    assert.equal(settled.length, 2);
    // dp-s2 rejected after dp-s1 approved → dp-s2 has higher decidedAt
    assert.equal(settled[0].proposalId, 'dp-s2');
    assert.equal(settled[1].proposalId, 'dp-s1');
  });

  // =====================================================================
  // Phase J: Lineage-based supersede (AC-J4, INV-J5)
  // =====================================================================

  it('Phase J: same-K create supersedes previous pending (AC-J4)', async () => {
    const r1 = await store.create({ ...baseInput, proposalId: 'dp-old', createdAt: 1000 });
    assert.equal(r1.supersededProposals.length, 0);
    await anchor('dp-old');

    // Same K (same source, target, sender) → supersedes dp-old
    const r2 = await store.create({ ...baseInput, proposalId: 'dp-new', createdAt: 2000 });
    assert.equal(r2.supersededProposals.length, 1);
    assert.equal(r2.supersededProposals[0].proposalId, 'dp-old');
    assert.equal(r2.supersededProposals[0].status, 'superseded');
    assert.equal(r2.supersededProposals[0].supersededBy, 'dp-new');

    // Verify dp-old is actually superseded in Redis
    const old = await store.get('dp-old');
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, 'dp-new');
  });

  it('Phase J: INV-J5 — no dual pending with same K', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-1', createdAt: 1000 });
    await anchor('dp-1');
    await store.create({ ...baseInput, proposalId: 'dp-2', createdAt: 2000 });
    await anchor('dp-2');
    await store.create({ ...baseInput, proposalId: 'dp-3', createdAt: 3000 });

    // Only dp-3 should be pending; dp-1 and dp-2 should be superseded
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-3');

    const dp1 = await store.get('dp-1');
    assert.equal(dp1.status, 'superseded');
    const dp2 = await store.get('dp-2');
    assert.equal(dp2.status, 'superseded');
  });

  it('Phase J: different K → no supersede (isolation)', async () => {
    // Different targetThreadId → different K
    await store.create({ ...baseInput, proposalId: 'dp-k1', targetThreadId: 'thread-a', createdAt: 1000 });
    await store.create({ ...baseInput, proposalId: 'dp-k2', targetThreadId: 'thread-b', createdAt: 2000 });

    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 2);
  });

  it('Phase J: already-decided proposals not superseded by new create', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-decided', createdAt: 1000 });
    await store.approve('dp-decided', 'user-1');

    // Same K, new create — dp-decided is approved (not pending), so Lua skips it
    const r2 = await store.create({ ...baseInput, proposalId: 'dp-after', createdAt: 2000 });
    assert.equal(r2.supersededProposals.length, 0);

    const decided = await store.get('dp-decided');
    assert.equal(decided.status, 'approved', 'approved proposal must not be touched');
  });

  it('Phase J: superseded proposals excluded from listPending', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-sup1', createdAt: 1000 });
    await anchor('dp-sup1');
    await store.create({ ...baseInput, proposalId: 'dp-sup2', createdAt: 2000 });

    const pending = await store.listPendingByUser('user-1');
    const ids = pending.map((p) => p.proposalId);
    assert.ok(!ids.includes('dp-sup1'), 'superseded must not appear in pending');
    assert.ok(ids.includes('dp-sup2'), 'current holder must be in pending');
  });

  // =====================================================================
  // Phase J: revertToPending lineage guard (INV-J5)
  // =====================================================================

  it('Phase J: revertToPending with no successor → reverts normally', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-rv1', createdAt: 1000 });
    await store.approve('dp-rv1', 'user-1', 'strict');

    const reverted = await store.revertToPending('dp-rv1');
    assert.ok(reverted, 'should revert when no successor');
    assert.equal(reverted.status, 'pending');

    const fetched = await store.get('dp-rv1');
    assert.equal(fetched.status, 'pending');
    assert.equal(await store.getApprovalOwnerAuthProvenance('dp-rv1'), undefined);
  });

  it('Phase J: revertToPending with successor → superseded (INV-J5 guard)', async () => {
    // dp-rv-old is created, approved, then a successor dp-rv-new is created with same K.
    // When dp-rv-old tries to revert (delivery failure), it should become superseded, not pending.
    await store.create({ ...baseInput, proposalId: 'dp-rv-old', createdAt: 1000 });
    await store.approve('dp-rv-old', 'user-1', 'strict');

    // Same K → dp-rv-old is approved (not pending), so Lua create doesn't supersede it.
    // But lineage now points to dp-rv-new.
    await store.create({ ...baseInput, proposalId: 'dp-rv-new', createdAt: 2000 });

    // Now dp-rv-old tries to revert (simulating delivery failure)
    const reverted = await store.revertToPending('dp-rv-old');
    assert.equal(reverted, null, 'revert must fail when successor holds lineage');

    // Verify dp-rv-old is now superseded (not pending)
    const old = await store.get('dp-rv-old');
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, 'dp-rv-new');
    assert.equal(await store.getApprovalOwnerAuthProvenance('dp-rv-old'), undefined);

    // dp-rv-new is still pending (no dual pending)
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-rv-new');
  });

  // --- Phase J: envelopeDigest round-trip ---

  it('Phase J: proposed action envelope round-trips through Redis', async () => {
    const proposedAction = {
      subjectRef: 'pr:owner/repo#42',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    };
    await store.create({
      ...baseInput,
      proposalId: 'dp-env',
      proposedAction,
      envelopeDigest: 'sha256:abc123',
    });
    const fetched = await store.get('dp-env');
    assert.deepEqual(fetched.proposedAction, proposedAction);
    assert.equal(fetched.envelopeDigest, 'sha256:abc123');
  });

  it('Phase J: proposal without envelopeDigest → field absent (legacy)', async () => {
    await store.create({ ...baseInput, proposalId: 'dp-legacy' });
    const fetched = await store.get('dp-legacy');
    assert.equal(fetched.envelopeDigest, undefined);
  });

  // --- Phase J: concurrent race (Sol R2 #4) ---

  it('Phase J: concurrent same-K creates → exactly one pending (Promise.all race)', async () => {
    const ids = ['dp-race-a', 'dp-race-b', 'dp-race-c'];
    await Promise.all(ids.map((id, i) => store.create({ ...baseInput, proposalId: id, createdAt: 1000 + i })));

    const pending = await store.listPendingByUser('user-1');
    const sameK = pending.filter(
      (p) =>
        p.sourceThreadId === baseInput.sourceThreadId &&
        p.targetThreadId === baseInput.targetThreadId &&
        p.senderCatId === baseInput.senderCatId,
    );
    assert.equal(sameK.length, 1, 'exactly one pending per K after concurrent creates (INV-J5)');
  });

  // --- Phase J: upgrade backfill (Sol R2 #3) ---

  it('Phase J: pre-existing pending without lineage key gets superseded on new create', async () => {
    // Simulate pre-Phase-J state: proposal exists in hash + pending index, but no lineage key.
    const oldId = 'dp-pre-upgrade';
    const hashKey = `dispatch-proposal:${oldId}`;
    const pendingKeyRaw = `dispatch-proposal-user-pending:${baseInput.ownerUserId}`;

    // Write directly via raw Redis commands (bypassing store.create which sets lineage)
    await redis.hset(
      hashKey,
      'proposalId',
      oldId,
      'sourceThreadId',
      baseInput.sourceThreadId,
      'targetThreadId',
      baseInput.targetThreadId,
      'senderCatId',
      baseInput.senderCatId,
      'ownerUserId',
      baseInput.ownerUserId,
      'effectClass',
      'assign_work',
      'content',
      'pre-upgrade content',
      'targetCats',
      JSON.stringify(baseInput.targetCats),
      'status',
      'pending',
      'createdAt',
      '500',
    );
    await redis.zadd(pendingKeyRaw, 500, oldId);
    // No lineage key set — simulating pre-Phase-J data

    // Now create a new proposal with the same K via the store
    const r2 = await store.create({ ...baseInput, proposalId: 'dp-post-upgrade', createdAt: 2000 });

    // Lazy backfill should have found the old pending and seeded lineage,
    // then Lua should have superseded it.
    assert.equal(r2.supersededProposals.length, 1);
    assert.equal(r2.supersededProposals[0].proposalId, oldId);
    assert.equal(r2.supersededProposals[0].status, 'superseded');

    // Only the new proposal should be pending
    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-post-upgrade');
  });

  // --- Phase J: multi-old-pending upgrade convergence (Sol R3 #1) ---

  it('Phase J: multiple pre-existing same-K pendings all converged on new create', async () => {
    // Simulate pre-Phase-J state: TWO old same-K pending proposals, no lineage key.
    // This was allowed pre-Phase-J. Both must be superseded when a new create arrives.
    const old1 = 'dp-multi-old1';
    const old2 = 'dp-multi-old2';
    const pendingKeyRaw = `dispatch-proposal-user-pending:${baseInput.ownerUserId}`;

    const writeOld = async (id, createdAt) => {
      const hashKey = `dispatch-proposal:${id}`;
      await redis.hset(
        hashKey,
        'proposalId',
        id,
        'sourceThreadId',
        baseInput.sourceThreadId,
        'targetThreadId',
        baseInput.targetThreadId,
        'senderCatId',
        baseInput.senderCatId,
        'ownerUserId',
        baseInput.ownerUserId,
        'effectClass',
        'assign_work',
        'content',
        `old content ${id}`,
        'targetCats',
        JSON.stringify(baseInput.targetCats),
        'status',
        'pending',
        'createdAt',
        String(createdAt),
      );
      await redis.zadd(pendingKeyRaw, createdAt, id);
    };

    await writeOld(old1, 500);
    await writeOld(old2, 700);
    // No lineage key — simulating pre-Phase-J data with multiple same-K pendings

    // Now create a new proposal with the same K via the store
    const result = await store.create({ ...baseInput, proposalId: 'dp-multi-new', createdAt: 2000 });

    // Both old proposals must be superseded
    assert.equal(result.supersededProposals.length, 2, 'both old same-K pendings must be superseded');
    const supersededIds = result.supersededProposals.map((p) => p.proposalId).sort();
    assert.deepStrictEqual(supersededIds, [old1, old2].sort());
    for (const sp of result.supersededProposals) {
      assert.equal(sp.status, 'superseded');
    }

    // Verify in Redis: both old proposals are superseded
    const fetchedOld1 = await store.get(old1);
    assert.equal(fetchedOld1.status, 'superseded', 'old1 must be superseded in Redis');
    const fetchedOld2 = await store.get(old2);
    assert.equal(fetchedOld2.status, 'superseded', 'old2 must be superseded in Redis');

    // Only the new proposal should be pending (INV-J5)
    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.equal(pending.length, 1, 'exactly one pending after multi-old convergence');
    assert.equal(pending[0].proposalId, 'dp-multi-new');
  });

  // --- Phase J: failed create atomicity (Sol R4 — failure-injection regression) ---

  it('Phase J: failed eval leaves all prior records and indexes unchanged', async () => {
    // Prove that create() is fully atomic: if the Lua eval fails, no mutations
    // are visible — old proposals stay pending, no lineage key, no new proposal.
    // This regresses the pre-R4 bug where SET NX + HSET happened before eval.
    const old1 = 'dp-fail-old1';
    const old2 = 'dp-fail-old2';
    const pendingKeyRaw = `dispatch-proposal-user-pending:${baseInput.ownerUserId}`;

    const writeOld = async (id, createdAt) => {
      const hashKey = `dispatch-proposal:${id}`;
      await redis.hset(
        hashKey,
        'proposalId',
        id,
        'sourceThreadId',
        baseInput.sourceThreadId,
        'targetThreadId',
        baseInput.targetThreadId,
        'senderCatId',
        baseInput.senderCatId,
        'ownerUserId',
        baseInput.ownerUserId,
        'effectClass',
        'assign_work',
        'content',
        `old content ${id}`,
        'targetCats',
        JSON.stringify(baseInput.targetCats),
        'status',
        'pending',
        'createdAt',
        String(createdAt),
      );
      await redis.zadd(pendingKeyRaw, createdAt, id);
    };

    await writeOld(old1, 500);
    await writeOld(old2, 700);

    // Create a store with a failing eval (simulates eval crash / network failure)
    const failRedis = Object.create(redis);
    failRedis.eval = async () => {
      throw new Error('Simulated eval failure (Sol R4 regression)');
    };
    const failStore = new RedisDispatchProposalStore(failRedis);

    // Attempt create — must throw, must NOT mutate any prior records
    await assert.rejects(
      () => failStore.create({ ...baseInput, proposalId: 'dp-fail-new', createdAt: 2000 }),
      /Simulated eval failure/,
    );

    // old1, old2 must still be pending (NOT superseded)
    const fetchedOld1 = await store.get(old1);
    assert.equal(fetchedOld1.status, 'pending', 'old1 must remain pending after failed create');
    const fetchedOld2 = await store.get(old2);
    assert.equal(fetchedOld2.status, 'pending', 'old2 must remain pending after failed create');

    // No lineage key written (Sol R5 P2 fix: separator is ':', not '|')
    const lineageKeyRaw = `dispatch-proposal-lineage:${baseInput.sourceThreadId}:${baseInput.targetThreadId}:${baseInput.senderCatId}`;
    const lineage = await redis.get(lineageKeyRaw);
    assert.equal(lineage, null, 'lineage key must not exist after failed create');

    // New proposal must not exist
    const newProposal = await store.get('dp-fail-new');
    assert.equal(newProposal, null, 'new proposal must not exist after failed create');

    // Pending index unchanged — both old proposals still present
    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.equal(pending.length, 2, 'pending count must be unchanged after failed create');
    const pendingIds = pending.map((p) => p.proposalId).sort();
    assert.deepStrictEqual(pendingIds, [old1, old2].sort());
  });

  // --- Phase J: dedup + eval-failure atomicity (Sol R5 — dedup orphan regression) ---

  it('Phase J: failed eval does not orphan dedup key (Sol R5 regression)', async () => {
    // Prove: if create() has clientMessageId and eval fails, the dedup key
    // is NOT written — so retry with same clientMessageId succeeds cleanly.
    const failRedis = Object.create(redis);
    failRedis.eval = async () => {
      throw new Error('Simulated eval failure (Sol R5 dedup regression)');
    };
    const failStore = new RedisDispatchProposalStore(failRedis);

    // Attempt create with clientMessageId — must throw
    await assert.rejects(
      () =>
        failStore.create({
          ...baseInput,
          proposalId: 'dp-dedup-fail',
          clientMessageId: 'cmid-orphan-test',
          createdAt: 1000,
        }),
      /Simulated eval failure/,
    );

    // Dedup key must NOT exist (no orphan)
    const dedupKeyRaw = `dispatch-proposal-clientmsg:${baseInput.sourceThreadId}:cmid-orphan-test`;
    const dedupValue = await redis.get(dedupKeyRaw);
    assert.equal(dedupValue, null, 'dedup key must not exist after failed create');

    // Retry with same clientMessageId, different proposalId — must succeed
    const retryResult = await store.create({
      ...baseInput,
      proposalId: 'dp-dedup-retry',
      clientMessageId: 'cmid-orphan-test',
      createdAt: 2000,
    });
    assert.equal(retryResult.proposal.proposalId, 'dp-dedup-retry');
    assert.equal(retryResult.proposal.status, 'pending');

    // findByClientMessageId must point to the retry proposal
    const found = await store.findByClientMessageId('cmid-orphan-test', baseInput.sourceThreadId);
    assert.ok(found, 'findByClientMessageId must find the retry proposal');
    assert.equal(found.proposalId, 'dp-dedup-retry');
  });

  // --- R4 P1-3: backfill supersededBy=keeperId regression (Redis Lua path) ---

  it('R4 P1-3: multi-old backfill → abort newId atomically restores only the keeper', async () => {
    // Exact sequence from Sol's review:
    // 1. Pre-Phase-J state: A (oldest, createdAt=500), B (keeper, createdAt=700), no lineage
    // 2. Create C (newId, createdAt=2000) → Lua backfills lineage=B, supersedes A&B
    //    R3 fix: stale A.supersededBy=keeperId(B), keeper B.supersededBy=C
    // 3. Abort C (simulating pre-card failure) → atomically restores keeper B
    const pendingKeyRaw = `dispatch-proposal-user-pending:${baseInput.ownerUserId}`;
    const writeOld = async (id, createdAt) => {
      const hashKey = `dispatch-proposal:${id}`;
      await redis.hset(
        hashKey,
        'proposalId',
        id,
        'sourceThreadId',
        baseInput.sourceThreadId,
        'targetThreadId',
        baseInput.targetThreadId,
        'senderCatId',
        baseInput.senderCatId,
        'ownerUserId',
        baseInput.ownerUserId,
        'effectClass',
        'assign_work',
        'content',
        `old content ${id}`,
        'targetCats',
        JSON.stringify(baseInput.targetCats),
        'status',
        'pending',
        'createdAt',
        String(createdAt),
      );
      await redis.zadd(pendingKeyRaw, createdAt, id);
    };

    await writeOld('dp-bf-A', 500);
    await writeOld('dp-bf-B', 700);

    // Create C with same K — triggers backfill, supersedes A & B
    const result = await store.create({ ...baseInput, proposalId: 'dp-bf-C', createdAt: 2000 });
    assert.equal(result.supersededProposals.length, 2, 'both A and B superseded');

    // Verify supersededBy assignments
    const fetchedA = await store.get('dp-bf-A');
    const fetchedB = await store.get('dp-bf-B');
    assert.equal(fetchedA.status, 'superseded');
    assert.equal(fetchedB.status, 'superseded');
    // R3 fix: stale A.supersededBy = keeperId (B), keeper B.supersededBy = C
    assert.equal(fetchedA.supersededBy, 'dp-bf-B', 'stale A.supersededBy must be keeper B');
    assert.equal(fetchedB.supersededBy, 'dp-bf-C', 'keeper B.supersededBy must be newId C');

    // Abort C (simulating pre-card failure)
    await store.abortStaged('dp-bf-C', 'simulated pre-card failure');

    const abortedB = await store.get('dp-bf-B');
    assert.equal(abortedB.status, 'pending', 'abortStaged(C) restores keeper B atomically');

    // Final state: only B pending, A stays superseded
    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    assert.equal(pending.length, 1, 'exactly one pending after rollback');
    assert.equal(pending[0].proposalId, 'dp-bf-B', 'only keeper B is pending');

    const finalA = await store.get('dp-bf-A');
    assert.equal(finalA.status, 'superseded', 'stale A stays superseded after rollback');
  });

  it('Phase J: successful create with clientMessageId claims dedup atomically', async () => {
    // Create with clientMessageId
    const r1 = await store.create({
      ...baseInput,
      proposalId: 'dp-dedup-ok',
      clientMessageId: 'cmid-atomic-test',
      createdAt: 1000,
    });
    assert.equal(r1.proposal.proposalId, 'dp-dedup-ok');

    // Second create with same clientMessageId returns existing (dedup hit)
    const r2 = await store.create({
      ...baseInput,
      proposalId: 'dp-dedup-dup',
      clientMessageId: 'cmid-atomic-test',
      createdAt: 2000,
    });
    assert.equal(r2.proposal.proposalId, 'dp-dedup-ok', 'dedup must return existing proposal');
    assert.equal(r2.supersededProposals.length, 0);

    // Only one proposal in pending
    const pending = await store.listPendingByUser(baseInput.ownerUserId);
    const withThisId = pending.filter((p) => p.proposalId === 'dp-dedup-ok' || p.proposalId === 'dp-dedup-dup');
    assert.equal(withThisId.length, 1);
    assert.equal(withThisId[0].proposalId, 'dp-dedup-ok');
  });
});
