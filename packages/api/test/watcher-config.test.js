import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';

test('watcher defaults are on, owner scoped, and independent of the front desk switch', async () => {
  const store = new MemoryConciergeConfigStore();
  await store.patch('owner', { enabled: false });
  const config = await store.readWatcherConfig('owner');
  assert.equal(config.enabled, true);
  assert.equal(config.memberCatId, 'codex61-sol');
  assert.equal(config.revision, 0);
  await store.updateWatcherConfig('owner', 0, { enabled: false });
  assert.equal((await store.readWatcherConfig('other')).enabled, true);
});

test('a watcher preference CAS preserves other settings and rejects stale tabs', async () => {
  const store = new MemoryConciergeConfigStore();
  await store.patch('owner', { displayName: '前台猫' });
  const first = await store.updateWatcherConfig('owner', 0, { doNotDisturbLabelIds: ['private'] });
  assert.equal(first.revision, 1);
  assert.equal(await store.updateWatcherConfig('owner', 0, { enabled: false }), null);
  await store.patch('owner', { muted: true });
  assert.equal((await store.getSaved('owner')).displayName, '前台猫');
  assert.equal((await store.getSaved('owner')).muted, true);
  const snapshot = await store.readWatcherConfig('owner');
  snapshot.doNotDisturbLabelIds.push('reader-mutation');
  assert.deepEqual((await store.readWatcherConfig('owner')).doNotDisturbLabelIds, ['private']);
});

test('concurrent watcher changes have one winner and cannot silently lose a user choice', async () => {
  const store = new MemoryConciergeConfigStore();
  const results = await Promise.all([
    store.updateWatcherConfig('owner', 0, { enabled: false }),
    store.updateWatcherConfig('owner', 0, { memberCatId: 'codex61-terra' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.readWatcherConfig('owner')).revision, 1);
});

test('reactivation has an identity even when its work floor is unchanged, while quiet preferences preserve it', async () => {
  const store = new MemoryConciergeConfigStore();
  await store.updateWatcherConfig('owner', 0, { enabled: false });
  const first = await store.updateWatcherConfig('owner', 1, { enabled: true }, 0);
  const quiet = await store.updateWatcherConfig('owner', 2, { doNotDisturbLabelIds: ['private'] });
  assert.equal(first.activationRevision, 2);
  assert.equal(quiet.activationRevision, first.activationRevision);
  assert.equal(quiet.activatedAt, first.activatedAt);
  await store.updateWatcherConfig('owner', 3, { enabled: false });
  const second = await store.updateWatcherConfig('owner', 4, { enabled: true }, 0);
  assert.equal(second.startedAfterSequence, first.startedAfterSequence);
  assert.notEqual(second.activationRevision, first.activationRevision);
});
