import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import {
  MemoryConciergeConfigStore,
  RedisConciergeConfigStore,
} from '../src/domains/concierge/ConciergeConfigStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const saved = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'removed-companion-profile' };
const redisFixture = ownedRedisFixture('f317-preserved-selection');

test('settings source preserves a retired selection while legacy reading retains its existing default resolution', async () => {
  const store = new MemoryConciergeConfigStore();
  assert.equal(catRegistry.has(saved.dutyCatProfileId), false);
  await store.put('owner', saved);
  assert.notEqual((await store.get('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal(
    (await store.getSaved('owner')).dutyCatProfileId,
    saved.dutyCatProfileId,
    'legacy reads do not rewrite the source',
  );
  assert.notEqual((await store.getSaved('another-owner')).dutyCatProfileId, saved.dutyCatProfileId);
  const copy = await store.getSaved('owner');
  copy.dutyCatProfileId = 'forged-after-read';
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
});

test('Redis settings read uses the same persistent owner record and never substitutes a stale saved ID', async () => {
  const redis = redisFixture.client('preserved:');
  const store = new RedisConciergeConfigStore(redis);
  await store.put('owner', saved);
  const source = await redis.get('concierge:config:owner');
  assert.notEqual((await store.get('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.notEqual((await store.getSaved('another-owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal(await redis.get('concierge:config:owner'), source);
  assert.equal(await redis.ttl('concierge:config:owner'), -1);
  assert.deepEqual(await redis.keys('preserved:*'), ['preserved:concierge:config:owner']);
});
