import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveThreadAttentionPreferences,
  saveThreadAttentionPreference,
} from '../dist/config/user-preferences-thread-attention.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';
import {
  applyThreadAttentionGroupCommand,
  resolveThreadAttentionGroups,
} from '../dist/domains/thread-navigation/thread-attention-group-metadata.js';

function fixture(options = {}) {
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
    ...options,
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

test('grouped create makes the first owner-visible thread a Group and reuses it after restart', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'plugin-grouped-threads-'));
  const notices = [];
  const f = fixture({ projectPath, onGroupedThreadCreated: (id) => notices.push(id) });
  const first = await f.host.createInGroup({ title: '问题反馈：搜索失败', groupName: '问题反馈' });
  const [group] = await resolveThreadAttentionGroups(f.store, 'owner');
  assert.deepEqual(group, { id: group.id, threadIds: [first.id], allowSingleton: true });
  assert.equal(resolveThreadAttentionPreferences(projectPath).aliases[`group:${group.id}`], '问题反馈');
  const restarted = fixture({ projectPath, threadStore: f.store });
  const second = await restarted.host.createInGroup({ title: '问题反馈：截图预览空白', groupName: '问题反馈' });
  assert.deepEqual(await resolveThreadAttentionGroups(f.store, 'owner'), [
    { ...group, threadIds: [first.id, second.id] },
  ]);
  assert.deepEqual(await resolveThreadAttentionGroups(f.store, 'someone-else'), []);
  assert.deepEqual(notices, [first.id]);
  await applyThreadAttentionGroupCommand(f.store, 'owner', { action: 'remove', groupId: group.id, threadId: first.id });
  assert.deepEqual(await resolveThreadAttentionGroups(f.store, 'owner'), [{ ...group, threadIds: [second.id] }]);
});

test('grouped create joins an existing owner-named group without moving prior conversations', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'plugin-existing-group-'));
  const f = fixture({ projectPath });
  const unrelated = await f.host.create({ title: '问题反馈：旧会话' });
  const a = await f.host.create({ title: 'Existing A' });
  const b = await f.host.create({ title: 'Existing B' });
  const [group] = await applyThreadAttentionGroupCommand(f.store, 'owner', {
    action: 'create',
    threadIds: [a.id, b.id],
  });
  saveThreadAttentionPreference(projectPath, { anchor: `group:${group.id}`, alias: '问题反馈' });
  const fresh = await f.host.createInGroup({ title: '问题反馈：新会话', groupName: '问题反馈' });
  assert.deepEqual(await resolveThreadAttentionGroups(f.store, 'owner'), [
    { ...group, threadIds: [a.id, b.id, fresh.id] },
  ]);
  assert.equal((await f.store.getThreadMetadata(unrelated.id))?.attentionGroup, undefined);
  await assert.rejects(f.host.createInGroup({ title: 'Invalid', groupName: ' ' }), /groupName/);
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
