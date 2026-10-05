import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisThreadStore } from '../src/domains/cats/services/stores/redis/RedisThreadStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
test(
  'production Redis Thread creation converges across clients and recovers the same indexed, persistent Work site',
  { skip: redisIsolationSkipReason(redisUrl) },
  async () => {
    assertRedisIsolationOrThrow(redisUrl, 'F290 owned execution Thread');
    assert.ok(redisUrl && new URL(redisUrl).port !== '6399', 'user Redis is never a test target');
    const keyPrefix = `f290-thread:${randomUUID()}:`;
    const first = createRedisClient({ url: redisUrl, keyPrefix });
    const second = createRedisClient({ url: redisUrl, keyPrefix });
    try {
      const firstStore = new RedisThreadStore(first);
      const secondStore = new RedisThreadStore(second);
      const stores = [firstStore, secondStore];
      const seed = {
        userId: 'owner',
        idempotencyKey: 'collective:exact-source:codex',
        title: 'A',
        participants: ['codex'],
        parentThreadId: 'channel',
        projectPath: '/permitted-project',
      };
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) => {
          const store = stores[index % 2];
          assert.ok(store);
          return store.ensureOwnedThread(seed);
        }),
      );
      assert.equal(new Set(results.map((thread) => thread.id)).size, 1);
      const thread = results[0];
      assert.ok(thread);
      assert.deepEqual(
        (await secondStore.list('owner')).filter((item) => item.id.startsWith('thread_owned_')).map((item) => item.id),
        [thread.id],
      );
      assert.deepEqual(
        (await secondStore.getChildThreads('channel')).map((child) => child.id),
        [thread.id],
      );
      assert.deepEqual((await secondStore.get(thread.id))?.participants, ['codex']);
      assert.equal(await first.ttl(`thread:${thread.id}`), -1);
      assert.equal(await first.ttl(`thread:${thread.id}:participants`), -1);
      const fresh = createRedisClient({ url: redisUrl, keyPrefix });
      try {
        const recovered = await new RedisThreadStore(fresh).ensureOwnedThread(seed);
        assert.equal(recovered.id, thread.id);
        assert.equal(recovered.createdBy, 'owner');
        await new RedisThreadStore(fresh).delete(thread.id);
        await assert.rejects(firstStore.ensureOwnedThread(seed), { code: 'OWNER_ADMISSION_UNAVAILABLE' });
      } finally {
        await fresh.quit();
      }
      const b = await firstStore.ensureOwnedThread({ ...seed, idempotencyKey: 'collective:source-B:codex' });
      assert.notEqual(b.id, thread.id);
      await first.hset(`thread:${b.id}`, 'createdBy', 'other-owner');
      await assert.rejects(secondStore.ensureOwnedThread({ ...seed, idempotencyKey: 'collective:source-B:codex' }), {
        code: 'OWNER_ADMISSION_UNAVAILABLE',
      });
      assert.equal(await first.hget(`thread:${b.id}`, 'createdBy'), 'other-owner');
    } finally {
      await cleanupClientKeyspace(first);
      await Promise.all([first.quit(), second.quit()]);
    }
  },
);
