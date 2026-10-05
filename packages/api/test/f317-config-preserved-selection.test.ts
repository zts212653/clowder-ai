import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  MemoryConciergeConfigStore,
  RedisConciergeConfigStore,
} from '../src/domains/concierge/ConciergeConfigStore.js';

const saved = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'removed-companion-profile' };

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
  const rows = new Map<string, string>();
  const writes: string[][] = [];
  const redis = {
    get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string, ...options: string[]) => {
      writes.push([key, value, ...options]);
      rows.set(key, value);
      return 'OK';
    },
  } as unknown as RedisClient;
  const store = new RedisConciergeConfigStore(redis);
  await store.put('owner', saved);
  const source = [...rows.entries()];
  assert.notEqual((await store.get('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.equal((await store.getSaved('owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.notEqual((await store.getSaved('another-owner')).dutyCatProfileId, saved.dutyCatProfileId);
  assert.deepEqual([...rows.entries()], source);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, 2, 'persistent configuration has no TTL or separate settings record');
});
