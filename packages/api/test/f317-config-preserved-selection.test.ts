import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import { RedisConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { readPluginConfig } from '../src/domains/plugin/plugin-config-store.js';
import { companionConfigurationFixture } from './helpers/companion-configuration-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const redisFixture = ownedRedisFixture('f317-preserved-selection');

test('companion settings are official.companion plugin configuration with manifest defaults', async () => {
  const companion = companionConfigurationFixture();
  const defaults = await companion.read();
  assert.equal(defaults.displayName, '猫猫球');
  assert.equal(defaults.proactivePolicy, 'quiet-badge');
  assert.equal(defaults.behaviorEnabled, true);
  assert.equal(defaults.skin, 'xianxian-codex');
  assert.equal(defaults.ballSize, 72);
  assert.ok(catRegistry.has(defaults.dutyCatProfileId), 'an unchosen member falls back to a roster member');
  companion.set({ dutyCatProfileId: 'opus', behaviorEnabled: false, ballSize: 96 });
  const saved = await companion.read();
  assert.equal(saved.dutyCatProfileId, 'opus');
  assert.equal(saved.behaviorEnabled, false);
  assert.equal(saved.ballSize, 96);
});

test('a saved member that is no longer a member reads as the roster default; reading never rewrites the configuration', async () => {
  const companion = companionConfigurationFixture({ dutyCatProfileId: 'removed-companion-profile' });
  assert.equal(catRegistry.has('removed-companion-profile'), false);
  assert.equal(
    (await companion.read()).dutyCatProfileId,
    (await companionConfigurationFixture().read()).dutyCatProfileId,
  );
  assert.deepEqual(readPluginConfig(companion.projectRoot, 'official.companion'), {
    dutyCatProfileId: 'removed-companion-profile',
  });
});

test('the Redis owner record keeps only runtime state and persists without expiry', async () => {
  const redis = redisFixture.client('preserved:');
  const store = new RedisConciergeConfigStore(redis);
  await store.put('owner', { ...CONCIERGE_CONFIG_DEFAULTS, householdReadsAllowed: false });
  assert.deepEqual(JSON.parse((await redis.get('concierge:config:owner')) as string), {
    ...CONCIERGE_CONFIG_DEFAULTS,
    householdReadsAllowed: false,
  });
  assert.equal(await redis.ttl('concierge:config:owner'), -1);
  assert.deepEqual(await redis.keys('preserved:*'), ['preserved:concierge:config:owner']);
});
