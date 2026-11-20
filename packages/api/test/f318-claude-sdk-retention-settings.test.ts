import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  CacheRetentionSettingsStore,
  cacheRetentionPreferenceKey,
} from '../src/domains/cats/services/session/cache/CacheRetentionSettingsStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
const options = { skip: redisIsolationSkipReason(url) };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  assertRedisIsolationOrThrow(url, 'F338 retention settings');
  const redis = createRedisClient({ url, keyPrefix: `test:f338-settings:${randomUUID()}:` });
  t.after(async () => {
    await redis.del(cacheRetentionPreferenceKey('alice', 'opus55'), cacheRetentionPreferenceKey('bob', 'opus55'));
    await redis.quit();
  });
  await redis.ping();
  return { redis, store: new CacheRetentionSettingsStore(redis) };
}

test(
  'F338: explicit preference survives a new reader without TTL or another owner inheriting it',
  options,
  async (t) => {
    const { redis, store } = await fixture(t);
    assert.equal((await store.get('alice', 'opus55')).enabled, false);
    const enabled = await store.set('alice', 'opus55', true);
    const recovered = await new CacheRetentionSettingsStore(redis).get('alice', 'opus55');
    assert.deepEqual(recovered, enabled);
    assert.equal(await redis.ttl(cacheRetentionPreferenceKey('alice', 'opus55')), -1);
    assert.equal((await store.get('bob', 'opus55')).enabled, false);
    const disabled = await store.set('alice', 'opus55', false);
    assert.ok(disabled.revision > enabled.revision);
    assert.equal((await new CacheRetentionSettingsStore(redis).get('alice', 'opus55')).enabled, false);
    assert.equal(await redis.ttl(cacheRetentionPreferenceKey('alice', 'opus55')), -1);
  },
);

test('F338: corrupted preference scope cannot enable another owner', options, async (t) => {
  const { redis, store } = await fixture(t);
  await redis.set(
    cacheRetentionPreferenceKey('alice', 'opus55'),
    JSON.stringify({
      userId: 'bob',
      catId: 'opus55',
      enabled: true,
      revision: 1,
      updatedAt: Date.now(),
    }),
  );
  await assert.rejects(store.get('alice', 'opus55'), /scope/);
});
