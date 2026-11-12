import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import {
  MemoryConciergeConfigStore,
  RedisConciergeConfigStore,
} from '../src/domains/concierge/ConciergeConfigStore.js';
import { readPluginConfig, writePluginConfig } from '../src/domains/plugin/plugin-config-store.js';
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
  const copy = await store.getSaved('owner');
  copy.dutyCatProfileId = 'forged-after-read';
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
});

test('Redis settings read uses the same persistent owner record and never substitutes a stale saved ID', async () => {
  const redis = redisFixture.client('preserved:');
  const store = new RedisConciergeConfigStore(redis, mkdtempSync(join(tmpdir(), 'concierge-')));
  await store.put('owner', saved);
  const source = await redis.get('concierge:config:owner');
  assert.notEqual((await store.get('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal(await redis.get('concierge:config:owner'), source);
  assert.equal(await redis.ttl('concierge:config:owner'), -1);
  assert.deepEqual(await redis.keys('preserved:*'), ['preserved:concierge:config:owner']);
});

test('companion settings are the companion plugin configuration', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'concierge-'));
  const store = new MemoryConciergeConfigStore(projectRoot);
  writePluginConfig(projectRoot, 'official.companion', [
    { name: 'dutyCatProfileId', value: 'opus' },
    { name: 'behaviorEnabled', value: 'false' },
    { name: 'ballSize', value: '96' },
  ]);
  const config = await store.get('owner');
  assert.equal(config.dutyCatProfileId, 'opus');
  assert.equal(config.behaviorEnabled, false);
  assert.equal(config.ballSize, 96);
  await store.patch('owner', { personaTone: 'Fixture', householdReadsAllowed: false });
  assert.equal(readPluginConfig(projectRoot, 'official.companion').personaTone, 'Fixture');
  assert.equal(readPluginConfig(projectRoot, 'official.companion').householdReadsAllowed, undefined);
  assert.equal((await store.getSaved('owner')).householdReadsAllowed, false);
});
