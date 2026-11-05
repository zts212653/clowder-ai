import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';

function fixture() {
  const store = new ThreadStore();
  let active = true;
  const host = createPluginThreadHost({
    pluginId: 'fixture',
    ownerUserId: 'owner',
    projectPath: '/isolated',
    threadDeepLinkUrl: (id) => `https://example.test/thread/${id}`,
    threadStore: store,
    assertCurrent: () => {
      if (!active) throw new Error('Instance stopped');
    },
    cats: {
      getAllCatIds: () => ['a', 'b'],
      getRegisteredServices: () =>
        new Map([
          ['a', {}],
          ['b', {}],
        ]),
      isCatAvailable: () => true,
      getCatAliases: (id) => [`@${id}`],
      getCatDisplayName: (id) => id,
    },
  });
  return {
    host,
    store,
    stop: () => {
      active = false;
    },
  };
}

test('ordinary threads are usable without plugin ownership or a Host business binding', async () => {
  const f = fixture();
  const parent = await f.store.create('owner', 'Parent', '/parent-project');
  const child = await f.host.create({ title: 'Child', parentThreadId: parent.id, participants: ['a'] });
  const stored = await f.store.get(child.id);
  assert.equal(stored.parentThreadId, parent.id);
  assert.equal(stored.projectPath, '/parent-project');
  assert.equal(stored.pluginOwnership, undefined);
  assert.deepEqual(stored.participants, ['a']);
  await f.host.addParticipants({ threadId: child.id, catIds: ['a', 'b'] });
  assert.deepEqual((await f.store.get(child.id)).participants, ['a', 'b']);
  await f.host.update(parent.id, { title: 'Updated', preferredCats: ['b'] });
  assert.equal((await f.host.get(parent.id)).title, 'Updated');
  assert.ok((await f.host.list()).some((t) => t.id === parent.id));
  for (const method of ['findByKey', 'ensureByKey', 'bind', 'unbind', 'listBindings', 'ensureSystemThread'])
    assert.equal(Object.hasOwn(f.host, method), false);
});

test('thread creation validates parent and participants before writing', async () => {
  const f = fixture();
  await assert.rejects(() => f.host.create({ title: 'Child', parentThreadId: 'missing' }), /does not exist/);
  await assert.rejects(() => f.host.create({ title: 'Child', participants: ['unknown'] }), /unknown/);
  const parent = await f.store.create('owner', 'Deleted');
  parent.deletedAt = 1;
  await assert.rejects(() => f.host.create({ title: 'Child', parentThreadId: parent.id }), /does not exist/);
  assert.equal((await f.store.list('owner')).length, 0);
});

test('stopped instances reject ordinary operations', async () => {
  const f = fixture(['thread.readContent']);
  const thread = await f.store.create('owner', 'Existing');
  f.stop();
  await assert.rejects(() => f.host.get(thread.id), /stopped/);
});

test('ordinary create exposes no retry-key or business-binding API', async () => {
  const f = fixture();
  await assert.rejects(
    f.host.create({ title: 'Thread', idempotencyKey: 'a9f93cac-1b4c-4e2e-a4bc-3e0e0e71941b' }),
    /input must contain/,
  );
  assert.equal((await f.store.list('owner')).length, 0);
});

test('ordinary create without a key remains ordinary creation, without a binding registry', async () => {
  const f = fixture();
  const a = await f.host.create({ title: 'Same title' });
  const b = await f.host.create({ title: 'Same title' });
  assert.notEqual(a.id, b.id);
});
