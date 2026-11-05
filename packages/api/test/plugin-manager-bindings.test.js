import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginManagerBindings } from '../dist/domains/plugin/manager/plugin-manager-bindings.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

test('Manager omits the Host system binding from external conversations', async () => {
  const store = new MemoryConnectorThreadBindingStore();
  store.bind('arbitrary.plugin', '__plugin_system_thread__', 'system-thread', 'owner');
  store.bind('arbitrary.plugin', 'room', 'external-thread', 'owner');
  const lookedUp = [];
  const service = new PluginManagerBindings(store, {
    get: async (id) => {
      lookedUp.push(id);
      return { createdBy: 'owner', title: id };
    },
  });
  assert.deepEqual(
    (await service.list('arbitrary.plugin', 'owner')).map((row) => row.key),
    ['room'],
  );
  assert.deepEqual(lookedUp, ['external-thread']);
});

test('Manager rejects a crafted system binding disconnect before invoking storage', async () => {
  const store = new MemoryConnectorThreadBindingStore();
  const reserved = store.bind('arbitrary.plugin', '__plugin_system_thread__', 'system-thread', 'owner');
  const service = new PluginManagerBindings(
    {
      listByUser: (...args) => store.listByUser(...args),
      removeIfMatches: () => {
        assert.fail('reserved binding must not reach storage mutation');
      },
    },
    { get: async () => null },
  );
  assert.equal(
    await service.disconnect('arbitrary.plugin', 'owner', {
      key: reserved.externalChatId,
      threadId: reserved.threadId,
      createdAt: reserved.createdAt,
    }),
    false,
  );
  assert.deepEqual(store.getByExternal('arbitrary.plugin', reserved.externalChatId), reserved);
});

test('owner disconnect compares the displayed binding and preserves a concurrent rebind', async () => {
  const store = new MemoryConnectorThreadBindingStore();
  const shown = store.bind('arbitrary.plugin', 'external/1', 'thread-1', 'owner');
  store.bind('arbitrary.plugin', 'external/1', 'thread-2', 'owner');
  assert.equal(await store.removeIfMatches(shown), false);
  assert.equal(store.getByExternal('arbitrary.plugin', 'external/1').threadId, 'thread-2');
  const latest = store.getByExternal('arbitrary.plugin', 'external/1');
  assert.equal(await store.removeIfMatches({ ...latest, userId: 'intruder' }), false);
  assert.equal(await store.removeIfMatches(latest), true);
  assert.deepEqual(store.getByThread('thread-2'), []);
  assert.equal(await store.removeIfMatches(latest), false);
});

test('Manager binds an arbitrary plugin to the authenticated owner without exposing another owner title', async () => {
  const store = new MemoryConnectorThreadBindingStore();
  store.bind('arbitrary.plugin', 'mine', 'thread-1', 'owner');
  store.bind('arbitrary.plugin', 'theirs', 'thread-2', 'other');
  store.bind('other.plugin', 'mine', 'thread-1', 'owner');
  const service = new PluginManagerBindings(store, {
    get: async () => ({ createdBy: 'other', title: 'Private title' }),
  });
  const rows = await service.list('arbitrary.plugin', 'owner');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'mine');
  assert.equal(rows[0].threadTitle, null);
  assert.equal(await service.disconnect('arbitrary.plugin', 'other', rows[0]), false);
  assert.equal(await service.disconnect('arbitrary.plugin', 'owner', rows[0]), true);
  assert.equal(store.listByUser('other.plugin', 'owner').length, 1);
  assert.equal(store.listByUser('arbitrary.plugin', 'other').length, 1);
});
