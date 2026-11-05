import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'real isolated Redis batch hydration equals full individual reads across bounded chunks',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'canonical full batch');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    const messages = new RedisMessageStore(redis),
      threads = new RedisThreadStore(redis);
    const ids = Array.from({ length: 17 }, (_, index) => `canonical-${randomUUID()}-${index}`);
    const keys = ids.flatMap((id) => [`msg:${id}`, `thread:${id}`, `thread:${id}:participants`]);
    t.after(async () => {
      try {
        await redis.del(...keys);
      } finally {
        await redis.quit();
      }
    });
    for (const id of ids) {
      await redis.hset(`thread:${id}`, {
        id,
        createdBy: 'owner',
        title: '完整对话',
        createdAt: '1',
        lastActiveAt: '1',
      });
      await redis.sadd(`thread:${id}:participants`, 'codex61-sol');
      await redis.hset(`msg:${id}`, {
        id,
        threadId: id,
        userId: 'owner',
        timestamp: '42',
        content: '原文 😀',
        from: JSON.stringify({ kind: 'user', userId: 'owner' }),
        contentBlocks: JSON.stringify([{ type: 'text', text: '完整正文块' }]),
        extra: JSON.stringify({ rich: { blocks: [] } }),
      });
    }
    const allMessages = await messages.getByIds([...ids, 'missing-canonical-message']);
    const allThreads = await threads.getMany(ids);
    for (const id of ids) {
      assert.deepEqual(allMessages.get(id), await messages.getById(id));
      assert.deepEqual(allThreads.get(id), await threads.get(id));
      assert.deepEqual(allThreads.get(id).participants, ['codex61-sol']);
    }
    assert.equal(allMessages.get('missing-canonical-message'), null);
  },
);
