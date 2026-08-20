import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-redis',
    revision: 1,
    intent: 'user_message',
    status: 'queued',
    allTargetCats: ['codex', 'fable5'],
    pendingTargetCats: ['codex', 'fable5'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('F264 Gap F true recall contract (Redis store)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let QueuedMessageCustodyCoordinator;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F264 true recall Redis');
    const [{ RedisMessageStore }, { createRedisClient }, custodyModule] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
    ]);
    QueuedMessageCustodyCoordinator = custodyModule.QueuedMessageCustodyCoordinator;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  async function appendQueued(queueCustody = custody()) {
    return store.append({
      threadId: 'thread-f264-gap-f-redis',
      userId: 'owner-redis',
      catId: null,
      content: '修正后的正文',
      contentBlocks: [{ type: 'image', url: '/uploads/proof.png' }],
      mentions: ['codex', 'fable5'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody,
      replyTo: 'parent-message',
    });
  }

  it('rejects foreign owner and thread without mutating either Redis hash', async () => {
    const message = await appendQueued();
    const beforeMessage = await store.getById(message.id);

    for (const identity of [
      { ownerUserId: 'foreign-owner', threadId: 'thread-f264-gap-f-redis' },
      { ownerUserId: 'owner-redis', threadId: 'thread-foreign' },
    ]) {
      assert.deepEqual(
        await store.recallMessageToComposerDraft(message.id, {
          ...identity,
          expectedDraftRevision: 0,
          merge: 'replace',
          recalledAt: 2_000,
        }),
        { kind: 'unauthorized' },
      );
    }

    assert.deepEqual(await store.getById(message.id), beforeMessage);
    assert.equal(await store.getOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis'), null);
    assert.equal(await store.getOwnerComposerDraft('foreign-owner', 'thread-f264-gap-f-redis'), null);
    assert.equal(await store.getOwnerComposerDraft('owner-redis', 'thread-foreign'), null);
  });

  it('commits zero-exposure body transfer and tombstone in one Lua CAS', async () => {
    const message = await appendQueued();
    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'zero_exposure');
    assert.equal(result.draft.text, '修正后的正文');
    assert.equal(result.message.content, '');
    assert.equal(result.message.deliveryStatus, 'canceled');
    assert.equal(result.message.recall.exposure, 'none');
    assert.equal(
      await redis.ttl(
        `msg:composer-draft:${encodeURIComponent('owner-redis')}:${encodeURIComponent('thread-f264-gap-f-redis')}`,
      ),
      -1,
    );
  });

  it('persists the same valid terminal reminder settlement as the memory store', async () => {
    const message = await appendQueued(
      custody({
        reminderAttempts: [
          {
            id: 'reminder-redis-delivered',
            targetCatId: 'codex',
            invocationId: 'child-redis',
            state: 'delivered',
            requestedAt: 120,
            deliveredAt: 140,
          },
        ],
      }),
    );

    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.deepEqual(result.message.queueCustody.reminderAttempts, [
      {
        id: 'reminder-redis-delivered',
        targetCatId: 'codex',
        invocationId: 'child-redis',
        state: 'missed',
        requestedAt: 120,
        deliveredAt: 140,
        missedAt: 2_000,
        missedReason: 'source_withdrawn',
      },
    ]);
    assert.deepEqual(
      (await store.getById(message.id)).queueCustody.reminderAttempts,
      result.message.queueCustody.reminderAttempts,
    );
  });

  it('preserves exact exposure lineage while hiding the body from default reads', async () => {
    const message = await appendQueued(
      custody({
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-codex' },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-codex', seenAt: 1_500 }],
      }),
    );
    const visibilityKey = 'msg:visibility:thread-f264-gap-f-redis';
    await redis
      .multi()
      .zadd(visibilityKey, 1_400, message.id)
      .hset(`msg:${message.id}`, 'visibilitySeq', '1400')
      .exec();
    const publishedScore = await redis.zscore(visibilityKey, message.id);
    assert.notEqual(publishedScore, null);
    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'exposed');
    assert.deepEqual(result.message.recall.exposures, [
      { targetCatId: 'codex', invocationId: 'child-codex', seenAt: 1_500 },
    ]);
    const indexed = await store.getByQueueExposure('thread-f264-gap-f-redis', 'codex', 'child-codex');
    assert.deepEqual(
      indexed.map((candidate) => candidate.id),
      [message.id],
    );
    assert.equal((await store.getByThread('thread-f264-gap-f-redis')).length, 0);
    assert.equal(
      (
        await store.getByThread('thread-f264-gap-f-redis', 20, 'owner-redis', {
          includeRecalledUserMessages: true,
        })
      ).length,
      1,
    );
    assert.equal(await redis.zscore(visibilityKey, message.id), publishedScore, 'recall retains the published cursor');
    const [incrementalTombstone] = await store.getByThreadAfter(
      'thread-f264-gap-f-redis',
      undefined,
      20,
      'owner-redis',
      { includeRecalledUserMessages: true },
    );
    assert.equal(incrementalTombstone.id, message.id);
    assert.equal(incrementalTombstone.content, '');
  });

  it('appends a late exact handling witness to an exposed tombstone without delivering or restoring it', async () => {
    const message = await appendQueued(
      custody({
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-codex-late' },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-codex-late', seenAt: 1_500 }],
      }),
    );
    const recalled = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(recalled.kind, 'recalled');
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => 2_200 });

    const settlement = await coordinator.commitSuccessfulTargetForMessage(
      'entry-redis',
      message.id,
      'codex',
      'child-codex-late',
      2_200,
      {
        invocationId: 'child-codex-late',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-codex-late' },
        handledAt: 2_200,
      },
    );

    assert.deepEqual(settlement.handledTargetCats, ['codex']);
    const terminal = await store.getById(message.id);
    assert.equal(terminal.content, '');
    assert.equal(terminal.deliveryStatus, 'canceled');
    assert.deepEqual(terminal.queueCustody.handledByCatIds, ['codex']);
    assert.deepEqual(terminal.queueCustody.withdrawnByCatIds, ['fable5']);
    assert.equal(terminal.queueCustody.targetOutcomeByCatId.codex.invocationId, 'child-codex-late');
  });

  it('does not mutate either hash when the draft revision is stale', async () => {
    const message = await appendQueued();
    await store.putOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis', {
      expectedRevision: 0,
      text: '已有草稿',
      updatedAt: 1_500,
    });
    const beforeMessage = await store.getById(message.id);
    const beforeDraft = await store.getOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis');
    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'append',
      recalledAt: 2_000,
    });
    assert.deepEqual(result, { kind: 'draft_revision_mismatch', actualRevision: 1 });
    assert.deepEqual(await store.getById(message.id), beforeMessage);
    assert.deepEqual(await store.getOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis'), beforeDraft);
  });

  it('round-trips ContextAttachment blocks in the owner composer draft', async () => {
    const contentBlocks = [
      { type: 'image', url: '/uploads/durable-draft.png' },
      {
        type: 'context_attachment',
        attachment: {
          v: 1,
          id: 'ctx-redis-durable-draft',
          kind: 'quote',
          text: 'durable selected passage',
          comment: 'durable paired comment',
          source: {
            kind: 'message',
            threadId: 'thread-f264-gap-f-redis',
            messageId: 'message-redis-durable-source',
          },
        },
      },
    ];
    const result = await store.putOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis', {
      expectedRevision: 0,
      text: 'durable text',
      contentBlocks,
      updatedAt: 1_500,
    });

    assert.equal(result.kind, 'updated');
    assert.deepEqual(result.draft.contentBlocks, contentBlocks);
    assert.deepEqual(
      (await store.getOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis')).contentBlocks,
      contentBlocks,
    );
  });

  it('matches MemoryStore by recalling an already delivered handled source', async () => {
    const message = await appendQueued(
      custody({
        status: 'terminal',
        pendingTargetCats: [],
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-handled' },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-handled', seenAt: 1_500 }],
        handledByCatIds: ['codex', 'fable5'],
      }),
    );
    assert.equal((await store.markDelivered(message.id, 1_800)).deliveryTransitioned, true);

    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'exposed');
    assert.deepEqual(result.message.queueCustody.handledByCatIds, ['codex', 'fable5']);
    assert.deepEqual(result.message.queueCustody.withdrawnByCatIds, []);
    assert.equal(result.message.content, '');
  });

  it('keeps a content-free revision tombstone after clear to prevent revision ABA', async () => {
    await store.putOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis', {
      expectedRevision: 0,
      text: '即将发送',
      updatedAt: 1_500,
    });
    assert.deepEqual(await store.clearOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis', 1, 2_000), {
      kind: 'cleared',
      revision: 2,
    });
    const cleared = await store.getOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis');
    assert.equal(cleared.revision, 2);
    assert.equal(cleared.text, '');
    assert.deepEqual(
      await store.putOwnerComposerDraft('owner-redis', 'thread-f264-gap-f-redis', {
        expectedRevision: 0,
        text: '旧标签页正文',
        updatedAt: 2_500,
      }),
      { kind: 'revision_mismatch', actualRevision: 2 },
    );
  });

  it('removes mention index members and atomically rejects late extra resurrection', async () => {
    const message = await appendQueued();
    assert.notEqual(await redis.zscore('msg:mentions:codex', message.id), null);
    const recalled = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(recalled.kind, 'recalled');

    assert.equal(await redis.zscore('msg:mentions:codex', message.id), null);
    assert.equal(await store.updateExtra(message.id, { rich: { kind: 'legacy-copy', body: '修正后的正文' } }), null);
    assert.equal(await redis.hget(`msg:${message.id}`, 'extra'), null);
  });
});
