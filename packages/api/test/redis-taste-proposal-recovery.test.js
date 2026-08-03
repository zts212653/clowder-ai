import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PATTERNS = [
  'taste-proposal:*',
  'taste-proposal-user-pending:*',
  'taste-proposal-user-settled:*',
  'taste-proposal-dedup:*',
];

describe('Redis Taste proposal crash recovery', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisTasteProposalStore;
  let F221ApprovalAdapter;
  let approveTasteProposal;
  let SessionMutex;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis Taste proposal crash recovery');
    ({ RedisTasteProposalStore } = await import('../dist/domains/taste/stores/redis/RedisTasteProposalStore.js'));
    ({ F221ApprovalAdapter } = await import('../dist/domains/approval-hub/adapters/F221ApprovalAdapter.js'));
    ({ approveTasteProposal } = await import('../dist/domains/taste/services/approveTasteProposal.js'));
    ({ SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    connected = true;
  });

  afterEach(async () => {
    if (connected) await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    await redis.quit();
  });

  it('a fresh store and Hub adapter expose resume-only, then finalize the checkpoint exactly once', async () => {
    const beforeCrash = new RedisTasteProposalStore(redis);
    const proposal = await beforeCrash.create({
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: 'thread-1',
      scene: 'durable Git write completed before process loss',
      quote: 'resume safely',
      tags: ['recovery'],
      dimension: 'system-philosophy',
      privacy: 'public',
    });
    await beforeCrash.commitEnvelope(proposal.id, {
      canonicalProposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      originRef: {
        kind: 'event',
        anchor: 'test:redis-taste-recovery',
        summary: 'Redis taste proposal crash recovery fixture',
        threadId: proposal.threadId,
      },
      approvalCardRef: { threadId: proposal.threadId, messageId: 'message-redis-taste-recovery' },
      createdAt: proposal.createdAt,
    });
    await beforeCrash.claimForApproval(proposal.id, 'user-1');
    await beforeCrash.recordWriteCheckpoint(proposal.id, {
      vignetteSlug: 'system-philosophy-recovery',
      vignettePath: 'docs/taste/vignettes/system-philosophy-recovery.md',
    });

    const afterRestart = new RedisTasteProposalStore(redis);
    const adapter = new F221ApprovalAdapter(afterRestart);
    const [recoveryItem] = await adapter.listPending('user-1');
    assert.ok(recoveryItem);
    assert.equal(recoveryItem.decisionMode, 'resume-only');

    let writerCalls = 0;
    const deps = {
      store: afterRestart,
      lock: new SessionMutex(),
      lockKey: () => '/repo/docs/taste/index.md',
      writeVignette: async () => {
        writerCalls++;
        return { slug: 'should-not-run', path: 'should-not-run' };
      },
    };
    const resumed = await approveTasteProposal(proposal.id, 'user-1', deps);
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps);

    assert.equal(resumed.ok, true);
    assert.equal(resumed.recovered, true);
    assert.equal(retried.ok, true);
    assert.equal(writerCalls, 0);
    assert.equal((await afterRestart.get(proposal.id)).status, 'approved');
    assert.deepEqual(await adapter.listPending('user-1'), []);
  });

  it('create promotes the winning reservation to a persistent retry identity', async () => {
    const store = new RedisTasteProposalStore(redis);
    const userId = 'user-persistent';
    const clientRequestId = 'req-persistent';
    const proposalId = 'tp-persistent';
    await store.reserveDedup(userId, clientRequestId, proposalId);

    const reservationTtl = await redis.ttl(`taste-proposal-dedup:${userId}::${clientRequestId}`);
    assert.ok(reservationTtl > 0, 'pre-create reservation must remain crash-recoverable via a bounded TTL');

    await store.create({
      proposalId,
      clientRequestId,
      userId,
      catId: 'codex-sol',
      threadId: 'thread-persistent',
      scene: 'Publication recovery after a long outage',
      quote: 'Keep one canonical proposal and one approval card.',
      tags: ['recovery'],
      dimension: 'system-philosophy',
      privacy: 'public',
    });

    assert.equal(
      await redis.ttl(`taste-proposal-dedup:${userId}::${clientRequestId}`),
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
});
