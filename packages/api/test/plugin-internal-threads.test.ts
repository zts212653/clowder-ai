import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginThreadHost } from '../src/domains/plugin/host-surface/plugin-thread-host.js';
import { threadsRoutes } from '../src/routes/threads.js';

test('marks the exact legacy coordination child without hiding main, ordinary children or foreign plugin threads', async () => {
  const store = new ThreadStore();
  const main = store.create('owner', '我的助手', 'default');
  const coordination = store.create('owner', 'arbitrary renamed coordination', 'default', main.id);
  const ordinary = store.create('owner', 'ordinary work', 'default', main.id);
  const foreign = store.create('owner', 'other plugin', 'default', main.id);
  store.updatePluginOwnership(foreign.id, { v: 1, pluginInstanceId: 'other' });
  const deps = {
    pluginId: 'dev.resident',
    pluginInstanceId: 'resident',
    ownerUserId: 'owner',
    projectPath: 'default',
    threadStore: store,
    threadDeepLinkUrl: (id: string) => `/thread/${id}`,
    isBoundMainThread: async (id: string) => id === main.id,
  };
  const host = createPluginThreadHost(deps);
  const patch = { title: 'arbitrary renamed coordination', internal: true as const };
  const marked = await host.update(coordination.id, patch);
  assert.equal(store.get(coordination.id)?.systemKind, 'plugin_internal');
  assert.deepEqual(store.get(coordination.id)?.pluginOwnership, { v: 1, pluginInstanceId: 'resident' });
  assert.equal('internal' in marked && marked.internal, true);
  assert.equal(store.get(main.id)?.systemKind, undefined);
  assert.equal(store.get(ordinary.id)?.systemKind, undefined);
  await assert.rejects(host.update(foreign.id, patch), /plugin|internal/i);
  await assert.rejects(host.update(main.id, patch), /parent|internal/i);
  const unbound = store.create('owner', 'unbound parent', 'default');
  const unrelated = store.create('owner', 'unrelated child', 'default', unbound.id);
  await assert.rejects(host.update(unrelated.id, patch), /plugin|internal/i);
  assert.equal(store.get(unrelated.id)?.title, 'unrelated child', 'reject before renaming or hiding');
});

test('new internal creation is explicit and rejects an unowned parent before creating a thread', async () => {
  const store = new ThreadStore();
  const deps = {
    pluginId: 'dev.resident',
    pluginInstanceId: 'resident',
    ownerUserId: 'owner',
    projectPath: 'default',
    threadStore: store,
    threadDeepLinkUrl: (id: string) => `/thread/${id}`,
  };
  const host = createPluginThreadHost(deps);
  const main = await host.create({ title: 'main' });
  const input = { title: 'coordination', parentThreadId: main.id, internal: true as const };
  const internal = await host.create(input);
  assert.equal(store.get(internal.id)?.systemKind, 'plugin_internal');
  const normal = await host.create({ title: 'normal work', parentThreadId: main.id });
  assert.equal(store.get(normal.id)?.systemKind, undefined);
  const unowned = store.create('owner', 'unowned', 'default');
  const count = store.list('owner').length;
  await assert.rejects(host.create({ ...input, parentThreadId: unowned.id }), /plugin|internal/i);
  assert.equal(store.list('owner').length, count);
});

test('ordinary and sidebar lists exclude internal coordination before unread hydration while direct owner access remains', async () => {
  const store = new ThreadStore();
  const main = store.create('owner', 'main', 'default');
  const internal = store.create('owner', 'coordination', 'default', main.id);
  store.updateSystemKind(internal.id, 'plugin_internal');
  const queried: string[][] = [];
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: store,
    messageStore: new MessageStore(),
    presenceSource: { getPresence: async () => new Map() },
    readStateStore: {
      get: () => null,
      ack: () => false,
      deleteByThread() {},
      getUnreadSummaries: (_user, ids) => {
        queried.push(ids);
        return ids.map((threadId) => ({ threadId, unreadCount: threadId === main.id ? 3 : 8, hasUserMention: false }));
      },
    },
  });
  try {
    for (const url of ['/api/threads', '/api/threads?view=sidebar']) {
      const response = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': 'owner' } });
      assert.equal(response.statusCode, 200, response.body);
      const rows = response.json().threads as { id: string; unreadCount: number }[];
      assert.deepEqual(
        rows.map((row) => row.id),
        [main.id],
      );
      assert.equal(rows[0].unreadCount, 3);
    }
    assert.ok(queried.every((ids) => !ids.includes(internal.id)));
    const direct = await app.inject({
      method: 'GET',
      url: `/api/threads/${internal.id}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(direct.statusCode, 200);
    assert.ok(store.get(internal.id), 'retain the record and history');
  } finally {
    await app.close();
  }
});
