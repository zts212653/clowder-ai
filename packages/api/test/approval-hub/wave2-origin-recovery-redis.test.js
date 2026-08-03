import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PATTERNS = [
  'dispatch-proposal:*',
  'dispatch-proposal-user-pending:*',
  'dispatch-proposal-user-settled:*',
  'dispatch-proposal-clientmsg:*',
  'dispatch-proposal-lineage:*',
  'entity-proposal:*',
  'entity-proposal-user-pending:*',
  'entity-proposal-user-settled:*',
  'entity-proposal-counter',
  'entity-proposal-dedup:*',
  'taste-proposal:*',
  'taste-proposal-user-pending:*',
  'taste-proposal-user-settled:*',
  'taste-proposal-dedup:*',
];

describe('Wave 2 recovery redis contract', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisDispatchProposalStore;
  let RedisEntityProposalStore;
  let RedisTasteProposalStore;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Wave 2 origin recovery redis contract');
    const [{ createRedisClient }, dispatchStoreModule, entityStoreModule, tasteStoreModule] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js'),
      import('../../dist/domains/approval-hub/stores/redis/RedisEntityProposalStore.js'),
      import('../../dist/domains/taste/stores/redis/RedisTasteProposalStore.js'),
    ]);
    RedisDispatchProposalStore = dispatchStoreModule.RedisDispatchProposalStore;
    RedisEntityProposalStore = entityStoreModule.RedisEntityProposalStore;
    RedisTasteProposalStore = tasteStoreModule.RedisTasteProposalStore;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  it('round-trips F193 approvalOriginRef across Redis persistence', async () => {
    const store = new RedisDispatchProposalStore(redis);
    const { proposal } = await store.create({
      proposalId: 'dp-origin-redis',
      sourceThreadId: 'thread-source',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Keep the first dispatch origin',
      targetCats: ['sonnet'],
      clientMessageId: 'dispatch-origin-redis',
      createdAt: Date.now(),
      approvalOriginRef: { kind: 'message', threadId: 'thread-source', messageId: 'msg-origin-a' },
    });

    const fresh = await new RedisDispatchProposalStore(redis).get(proposal.proposalId);
    assert.deepEqual(fresh?.approvalOriginRef, {
      kind: 'message',
      threadId: 'thread-source',
      messageId: 'msg-origin-a',
    });
  });

  it('round-trips F260 approvalOriginRef across Redis persistence', async () => {
    const store = new RedisEntityProposalStore(redis);
    const reserved = await store.reserveDedup('user-1', 'entity-origin-redis', 'ep-origin-redis');
    assert.equal(reserved, 'ep-origin-redis');
    const proposal = await store.create({
      proposalId: 'ep-origin-redis',
      entityId: 'concept:origin-redis',
      entityType: 'concept',
      canonicalName: 'Origin Redis',
      aliases: ['origin-redis'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Preserve original originRef across Redis recovery',
      sourceThreadId: 'thread-origin',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
      clientRequestId: 'entity-origin-redis',
      approvalOriginRef: { kind: 'message', threadId: 'thread-origin', messageId: 'msg-origin-a' },
    });

    const fresh = await new RedisEntityProposalStore(redis).get(proposal.proposalId);
    assert.deepEqual(fresh?.approvalOriginRef, {
      kind: 'message',
      threadId: 'thread-origin',
      messageId: 'msg-origin-a',
    });
  });

  it('round-trips F221 approvalOriginRef across Redis persistence', async () => {
    const store = new RedisTasteProposalStore(redis);
    const reserved = await store.reserveDedup('user-1', 'taste-origin-redis', 'tp-origin-redis');
    assert.equal(reserved, 'tp-origin-redis');
    const proposal = await store.create({
      proposalId: 'tp-origin-redis',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-origin',
      scene: 'A stable taste signal',
      quote: 'Keep the first origin',
      tags: ['authentic-expression'],
      dimension: 'authentic-expression',
      privacy: 'public',
      clientRequestId: 'taste-origin-redis',
      approvalOriginRef: {
        kind: 'event',
        anchor: 'invocation:inv-taste-original',
        summary: 'Taste proposal from opus',
        threadId: 'thread-origin',
      },
    });

    const fresh = await new RedisTasteProposalStore(redis).get(proposal.id);
    assert.deepEqual(fresh?.approvalOriginRef, {
      kind: 'event',
      anchor: 'invocation:inv-taste-original',
      summary: 'Taste proposal from opus',
      threadId: 'thread-origin',
    });
  });

  it('does not release F260 or F221 retry identity after the proposal was materialized', async () => {
    const entityStore = new RedisEntityProposalStore(redis);
    await entityStore.reserveDedup('user-1', 'entity-ambiguous-create', 'ep-ambiguous-create');
    await entityStore.create({
      proposalId: 'ep-ambiguous-create',
      entityId: 'concept:ambiguous-create',
      entityType: 'concept',
      canonicalName: 'Ambiguous create',
      aliases: ['ambiguous-create'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Keep the durable retry identity after a lost create acknowledgement',
      sourceThreadId: 'thread-origin',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
      clientRequestId: 'entity-ambiguous-create',
    });
    await entityStore.releaseDedup('user-1', 'entity-ambiguous-create', 'ep-ambiguous-create');
    assert.equal(await entityStore.getDedupProposalId('user-1', 'entity-ambiguous-create'), 'ep-ambiguous-create');

    const tasteStore = new RedisTasteProposalStore(redis);
    await tasteStore.reserveDedup('user-1', 'taste-ambiguous-create', 'tp-ambiguous-create');
    await tasteStore.create({
      proposalId: 'tp-ambiguous-create',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-origin',
      scene: 'A materialized proposal outlives an ambiguous create acknowledgement',
      quote: 'Keep its retry identity',
      tags: ['cognitive-honesty'],
      dimension: 'cognitive-honesty',
      privacy: 'public',
      clientRequestId: 'taste-ambiguous-create',
    });
    await tasteStore.releaseDedup('user-1', 'taste-ambiguous-create', 'tp-ambiguous-create');
    assert.equal(await tasteStore.getDedupProposalId('user-1', 'taste-ambiguous-create'), 'tp-ambiguous-create');
  });
});
