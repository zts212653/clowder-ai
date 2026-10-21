import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';

function fixture() {
  const store = new TaskStore();
  const host = createPluginTaskHost({
    pluginId: 'example',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.read', 'task.write'],
    taskStore: store,
    readThreadStore: { get: async (id) => ({ id, createdBy: 'owner' }) } as never,
  });
  return { store, host };
}

test('Task public surface has four methods; selectors and combined filters return the same owned task', async () => {
  const { store, host } = fixture();
  assert.deepEqual(Object.keys(host).sort(), ['create', 'get', 'list', 'update']);
  const task = store.create({
    threadId: 'thread',
    title: 'Work',
    why: '',
    createdBy: 'user',
    userId: 'owner',
    subjectKey: 'one',
  });
  store.create({ threadId: 'other', title: 'Other', why: '', createdBy: 'user', userId: 'owner' });
  assert.equal((await host.get({ id: task.id }))?.id, task.id);
  assert.equal((await host.get({ subjectKey: 'one' }))?.id, task.id);
  assert.deepEqual(
    (await host.list({ threadId: 'thread', kind: 'work' })).map((t) => t.id),
    [task.id],
  );
  assert.deepEqual(await host.list({ threadId: 'thread', kind: 'pr_tracking' }), []);
  assert.equal((await host.list({})).length, 2);
  await assert.rejects(host.get({ id: task.id, subjectKey: 'one' } as never), /selector/);
});

test('create rejects subject conflicts by default and explicitly updates the same subject atomically', async () => {
  const { host } = fixture();
  const input = { threadId: 'thread', title: 'Original', subjectKey: 'one' };
  const first = await host.create(input);
  await assert.rejects(host.create(input), /subject/i);
  const changed = await host.create({ ...input, title: 'Changed' }, { onConflict: 'update' });
  assert.equal(changed.id, first.id);
  assert.equal(changed.title, 'Changed');
  await assert.rejects(
    host.create({ threadId: 'thread', title: 'Missing key' }, { onConflict: 'update' }),
    /subjectKey/,
  );
});

test('conditional patch retains thread CAS and rejects mixed wait writes without any mutation', async () => {
  const { store, host } = fixture();
  const task = await host.create({ threadId: 'thread', title: 'Original' });
  assert.equal(await host.update(task.id, { title: 'Wrong' }, { expectedThreadId: 'other' }), null);
  const before = structuredClone(store.get(task.id));
  await assert.rejects(
    host.update(task.id, {
      title: 'Partial write',
      wait: { expectedGeneration: null, generation: 1, active: {} },
    } as never),
    /wait.*only|wait.*mixed/i,
  );
  assert.deepEqual(store.get(task.id), before);
  const original = store.updateIfThreadId.bind(store);
  store.updateIfThreadId = (id, expected, patch) => {
    store.update(id, { threadId: 'moved' });
    return original(id, expected, patch);
  };
  assert.equal(await host.update(task.id, { title: 'Race' }, { expectedThreadId: 'thread' }), null);
  assert.equal(store.get(task.id)?.title, 'Original');
});
