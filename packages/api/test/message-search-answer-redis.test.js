import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

for (const operation of ['bind', 'patch']) {
  test(
    `a plain completed Redis response with canonical empty extra supports its first ${operation}`,
    { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
    async () => {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'message-search-answer-empty-extra');
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `j6-empty-${randomUUID()}:` });
      try {
        const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
        const message = await store.append({
          from: { kind: 'agent', catId: 'opus' },
          userId: 'owner',
          threadId: 'origin',
          content: 'Plain completed response',
          mentions: [],
          timestamp: 2,
          origin: 'stream',
          lifecycle: {
            kind: 'response',
            orderKey: '1:plain',
            invocationId: `plain-${operation}`,
            targetId: 'opus',
            inputEntryIds: ['input'],
            inputMessageIds: [],
            status: 'completed',
            startedAt: 1,
            completedAt: 2,
          },
        });
        assert.equal(
          await redis.hget(MessageKeys.detail(message.id), 'extra'),
          '',
          'exercise the actual append encoding',
        );
        const binding = {
          v: 1,
          publicationRef: `message-search-answer:${'e'.repeat(64)}`,
          blockId: 'plain-card',
          responseDigest: 'f'.repeat(64),
        };
        if (operation === 'patch') {
          const tracing = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };
          const patched = await store.updateExtra(message.id, { tracing });
          assert.deepEqual(patched.extra.tracing, tracing);
          assert.equal(patched.extra.messageSearchAnswer, undefined, 'an ordinary patch cannot create authority');
        }
        const attached = await store.attachMessageSearchAnswer(message.id, {
          ownerUserId: 'owner',
          threadId: 'origin',
          catId: 'opus',
          binding,
        });
        assert.deepEqual(attached.extra.messageSearchAnswer, binding);
        await store.updateExtra(message.id, { rich: { v: 1, blocks: [] } });
        const hydrated = await new RedisMessageStore(redis, { ttlSeconds: 0 }).getById(message.id);
        assert.deepEqual(hydrated.extra.messageSearchAnswer, binding);
        assert.equal(hydrated.extra.rich.blocks.length, 1);
      } finally {
        await cleanupClientKeyspace(redis);
        await redis.quit();
      }
    },
  );
}

test(
  'Redis Host binding survives hydration and racing generic patches without transferring authority',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'message-search-answer');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `j6-answer-${randomUUID()}:` });
    try {
      await redis.ping();
      const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
      const message = await store.append({
        from: { kind: 'agent', catId: 'opus' },
        userId: 'owner',
        threadId: 'origin',
        content: 'Original answer',
        mentions: [],
        timestamp: 1,
        origin: 'callback',
        extra: { isExplicitPost: true },
      });
      const binding = {
        v: 1,
        publicationRef: `message-search-answer:${'a'.repeat(64)}`,
        blockId: 'same-card',
        responseDigest: 'b'.repeat(64),
      };
      const input = { ownerUserId: 'owner', catId: 'opus', threadId: 'origin', binding };
      // Hold a genuine ordinary-writer read before the Host commit. Its stale
      // extra snapshot must not erase the card when it writes after the commit.
      let enter, finish;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const release = new Promise((resolve) => {
        finish = resolve;
      });
      const get = store.getById.bind(store);
      store.getById = async (id) => {
        const row = await get(id);
        enter();
        await release;
        return row;
      };
      const updating = store.updateExtra(message.id, {
        messageSearchAnswer: { ...binding, publicationRef: `message-search-answer:${'c'.repeat(64)}` },
        targetCats: [],
      });
      await entered;
      store.getById = get;
      await store.attachMessageSearchAnswer(message.id, input);
      finish();
      await updating;
      const hydrated = await new RedisMessageStore(redis, { ttlSeconds: 0 }).getById(message.id);
      assert.deepEqual(hydrated.extra.messageSearchAnswer, binding);
      assert.equal(hydrated.extra.rich?.blocks.length, 1, 'a stale ordinary writer cannot erase the Host card');
      await store.updateExtra(message.id, { rich: { v: 1, blocks: [] } });
      assert.equal(
        (await store.getById(message.id)).extra.rich.blocks.length,
        1,
        'ordinary rich patches retain the Host-owned ref',
      );
      assert.equal((await store.attachMessageSearchAnswer(message.id, input)).extra.rich.blocks.length, 1);
      assert.equal(await store.attachMessageSearchAnswer(message.id, { ...input, ownerUserId: 'other' }), null);
      assert.equal(
        await store.attachMessageSearchAnswer(message.id, {
          ...input,
          binding: { ...binding, responseDigest: 'd'.repeat(64) },
        }),
        null,
      );
      assert.equal(await store.attachMessageSearchAnswer(message.id, { ...input, threadId: 'another-thread' }), null);
      const keys = await redis.keys(`${redis.options.keyPrefix}*`);
      for (const key of keys) assert.equal(await redis.ttl(key.slice(redis.options.keyPrefix.length)), -1);
      const copied = await store.append({
        from: { kind: 'agent', catId: 'opus' },
        userId: 'owner',
        threadId: 'origin',
        content: 'Copied ref',
        mentions: [],
        timestamp: 2,
        extra: { rich: hydrated.extra.rich },
      });
      assert.equal((await store.getById(copied.id)).extra.messageSearchAnswer, undefined);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
