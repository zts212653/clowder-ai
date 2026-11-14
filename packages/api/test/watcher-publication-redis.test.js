import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { watcherRawWindow } from '../dist/domains/concierge/watcher/watcher-prompt.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';
import { publicationFixture } from './helpers/watcher-publication.js';

test(
  'the Redis publication owner preserves the same lifecycle order after reconstruction, including legacy hashes',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 watcher publication window');
    const namespace = createAuthTestNamespace('watcher-publication');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    try {
      const f = await publicationFixture(new RedisMessageStore(redis, { ttlSeconds: 0 }));
      const state = { revision: 1, afterSequence: 1, notes: '', consumedThrough: f.baseline.id };
      const restored = new RedisMessageStore(redis, { ttlSeconds: 0 });
      for (const legacyHash of [false, true]) {
        if (legacyHash) {
          // The index remains authoritative when an old message hash lacks the projection field.
          for (const id of [f.baseline.id, f.early.id]) await redis.hdel(`msg:${id}`, 'visibilitySeq');
          assert.equal((await restored.getById(f.early.id)).visibilitySeq, undefined);
        }
        const window = await watcherRawWindow(restored, 'owner', 'line', state, f.early.id, 300, 625);
        assert.deepEqual(window.messageIds, [...f.between.map((m) => m.id), f.early.id]);
        assert.equal(window.resumeCursor, undefined);
        assert.ok(window.offset > 0);
      }
    } finally {
      await clearAuthTestNamespace(redis, namespace);
      await redis.quit();
    }
  },
);
