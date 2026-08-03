import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PATTERNS = [
  'proposal:*',
  'proposals:*',
  'dedup:propose:*',
  'handoff-proposal:*',
  'handoff-proposals:*',
  'handoff-proposal-dedup:*',
  'profile-update:*',
  'dedup:profile-update:*',
];

describe('Redis approval publication contract', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let cases;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis approval publication contract');
    const [{ createRedisClient }, f128, f225, f231] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/cats/services/stores/redis/RedisProposalStore.js'),
      import('../../dist/domains/cats/services/stores/redis/RedisSessionHandoffProposalStore.js'),
      import('../../dist/domains/cats/services/stores/redis/RedisProfileUpdateProposalStore.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    cases = [
      {
        producerId: 'F128',
        makeStore: () => new f128.RedisProposalStore(redis),
        create: (store, proposalId) =>
          store.create({
            proposalId,
            sourceThreadId: 'thread-1',
            sourceInvocationId: 'invocation-1',
            sourceCatId: 'codex-sol',
            title: 'Child thread',
            reason: 'Long-running work',
            parentThreadId: 'thread-1',
            preferredCats: [],
            projectPath: '/workspace',
            createdBy: 'user-1',
          }),
        ownerUserId: 'user-1',
      },
      {
        producerId: 'F225',
        makeStore: () => new f225.RedisSessionHandoffProposalStore(redis),
        create: (store, proposalId) =>
          store.create({
            proposalId,
            sourceThreadId: 'thread-1',
            sourceSessionId: 'session-1',
            sourceCatId: 'codex-sol',
            userId: 'user-1',
            note: { done: 'done', nextSteps: 'continue' },
          }),
        ownerUserId: 'user-1',
      },
      {
        producerId: 'F231',
        makeStore: () => new f231.RedisProfileUpdateProposalStore(redis),
        create: (store, proposalId) =>
          store.create({
            proposalId,
            sourceThreadId: 'thread-1',
            sourceInvocationId: 'invocation-1',
            sourceCatId: 'codex-sol',
            targetLayer: 'primer',
            targetPath: 'relationship/sol-primer.md',
            beforeContent: 'before',
            baseContentHash: 'hash',
            afterContent: 'after',
            rationale: 'operator instruction',
            signalProvenance: {
              kind: 'cvo-instructed',
              sourceThreadId: 'thread-1',
              sourceMessageId: 'origin-1',
            },
            createdBy: 'user-1',
          }),
        ownerUserId: 'user-1',
      },
    ];
  });

  after(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  it('round-trips staged and immutable anchored envelopes for every healthy producer', async () => {
    for (const fixture of cases) {
      const store = fixture.makeStore();
      const proposal = await fixture.create(store, `redis-${fixture.producerId.toLowerCase()}-anchor`);
      assert.equal(proposal.publication.state, 'staged');
      assert.equal((await fixture.makeStore().getPublication(proposal.proposalId)).state, 'staged');

      const envelope = {
        canonicalProposalId: proposal.proposalId,
        sourceFeatureId: fixture.producerId,
        ownerUserId: fixture.ownerUserId,
        requesterCatId: proposal.sourceCatId,
        originRef: { kind: 'message', threadId: proposal.sourceThreadId, messageId: 'origin-1' },
        approvalCardRef: { threadId: proposal.sourceThreadId, messageId: 'card-1' },
        createdAt: proposal.createdAt,
      };
      await assert.rejects(
        () => store.commitEnvelope(proposal.proposalId, { ...envelope, canonicalProposalId: 'other-proposal' }),
        /canonicalProposalId/,
      );
      await assert.rejects(
        () => store.commitEnvelope(proposal.proposalId, { ...envelope, sourceFeatureId: 'F193' }),
        /sourceFeatureId/,
      );
      await store.commitEnvelope(proposal.proposalId, envelope);
      await fixture.makeStore().commitEnvelope(proposal.proposalId, envelope);
      const fresh = await fixture.makeStore().get(proposal.proposalId);
      assert.deepEqual(fresh.publication, { state: 'anchored', envelope });
      assert.equal(fresh.cardMessageId, 'card-1');
      await assert.rejects(
        () =>
          store.commitEnvelope(proposal.proposalId, {
            ...envelope,
            approvalCardRef: { ...envelope.approvalCardRef, messageId: 'card-conflict' },
          }),
        /conflicting approval envelope/,
      );
    }
  });

  it('atomically removes only staged proposals and their indexes', async () => {
    for (const fixture of cases) {
      const store = fixture.makeStore();
      const proposal = await fixture.create(store, `redis-${fixture.producerId.toLowerCase()}-abort`);
      await store.abortStaged(proposal.proposalId, 'card append failed');
      assert.equal(await fixture.makeStore().get(proposal.proposalId), null);
      assert.equal(await fixture.makeStore().getPublication(proposal.proposalId), null);
    }
  });
});
