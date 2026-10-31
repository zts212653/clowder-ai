import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F264 Gap F true recall contract (Redis store)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F264 true recall Redis');
    const [{ RedisMessageStore }, { createRedisClient }] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('@cat-cafe/shared/utils'),
    ]);
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

  async function appendQueued() {
    return store.append(
      canonicalTestMessageInput({
        threadId: 'thread-f264-gap-f-redis',
        userId: 'owner-redis',
        catId: null,
        content: '修正后的正文',
        contentBlocks: [{ type: 'image', url: '/uploads/proof.png' }],
        mentions: ['codex', 'fable5'],
        timestamp: 1_000,
        deliveryStatus: 'queued',
        replyTo: 'parent-message',
      }),
    );
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

  it('removes a stale legacy visibility member when recalling still-pending work', async () => {
    const message = await appendQueued();
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
    assert.equal(result.verdict, 'zero_exposure');
    assert.equal(result.message.recall.exposures, undefined);
    const persisted = await store.getById(message.id);
    assert.equal(persisted.recall.exposures, undefined);
    assert.equal((await store.getByThread('thread-f264-gap-f-redis')).length, 0);
    assert.equal(
      (await store.getByThread('thread-f264-gap-f-redis', 20, 'owner-redis', { includeRecalledUserMessages: true }))
        .length,
      0,
    );
    assert.equal(await redis.zscore(visibilityKey, message.id), null);
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

  it('refuses an already delivered source because dequeue is terminal', async () => {
    const message = await appendQueued();
    assert.equal((await store.markDelivered(message.id, 1_800)).deliveryTransitioned, true);

    const result = await store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-redis',
      threadId: 'thread-f264-gap-f-redis',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(result.kind, 'not_recallable');
    assert.equal((await store.getById(message.id)).content, '修正后的正文');
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
