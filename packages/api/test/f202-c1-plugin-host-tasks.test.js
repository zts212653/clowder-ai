import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeTaskFixture(capabilities = ['task.read', 'task.write']) {
  const root = await tempRoot('cat-cafe-f202-task-package-');
  const manifest = {
    pluginId: 'dev.clowder.task-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Task fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(root, 'dist/plugin.js'),
    [
      'export default {',
      '  create() {',
      '    return {',
      '      start(host) {',
      '        return {',
      '          actions: {',
      "            'fixture.tasks': async ({ operation, ...input }) => {",
      "              if (operation === 'create') return host.tasks.create(input);",
      "              if (operation === 'get') return host.tasks.get({ id: input.taskId });",
      "              if (operation === 'list') return host.tasks.list({ threadId: input.threadId });",
      "              if (operation === 'listByKind') return host.tasks.list({ kind: input.kind });",
      "              if (operation === 'getBySubject') return host.tasks.get({ subjectKey: input.subjectKey });",
      "              if (operation === 'upsertBySubject') return host.tasks.create(input, { onConflict: 'update' });",
      "              if (operation === 'updateIfThreadId') return host.tasks.update(input.taskId, input.patch, { expectedThreadId: input.expectedThreadId });",
      '              return host.tasks.update(input.taskId, input.patch);',
      '            },',
      '          },',
      '          stop() {},',
      '        };',
      '      },',
      '    };',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('task calls report unavailable Host storage', async () => {
  const unavailable = createPluginTaskHost({
    pluginId: 'dev.clowder.authorized',
    taskStore: undefined,
  });
  await assert.rejects(() => unavailable.get({ id: 'task-1' }), /Host task store is unavailable/);
});

test('module plugins create, read, and update ordinary tasks through the Host task store', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-task-project-');
  const taskStore = new TaskStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('owner', 'Plugin task fixture');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    taskStore,
    threadStore,
    threadOwnerUserId: 'owner',
    contract: { manifestContractRange: '0.1.0', validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeTaskFixture() },
  });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });
  const invoke = (input) => runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.tasks', input);

  const created = await invoke({
    operation: 'create',
    threadId: thread.id,
    title: 'Inspect a migrated notification',
    why: 'Created by an installed plugin through the ordinary task store',
    kind: 'work',
  });
  assert.equal(created.threadId, thread.id);
  assert.equal(created.createdBy, 'system', 'the Host, not package code, owns the persisted task principal');
  const readTask = {
    id: created.id,
    kind: 'work',
    threadId: thread.id,
    subjectKey: null,
    title: 'Inspect a migrated notification',
    ownerCatId: null,
    status: 'todo',
    why: 'Created by an installed plugin through the ordinary task store',
    createdBy: 'system',
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    userId: null,
  };
  assert.deepEqual(await invoke({ operation: 'get', taskId: created.id }), readTask);
  assert.deepEqual(await invoke({ operation: 'list', threadId: thread.id }), [readTask]);

  const otherThread = threadStore.create('other-owner', 'Private');
  const foreign = taskStore.create({
    threadId: thread.id,
    title: 'Private task',
    why: 'not for this plugin',
    userId: 'other-owner',
    createdBy: 'user',
    subjectKey: 'foreign:subject',
  });
  const foreignLegacy = taskStore.create({
    threadId: otherThread.id,
    title: 'Private legacy',
    why: 'legacy',
    createdBy: 'user',
  });
  assert.equal(await invoke({ operation: 'get', taskId: foreign.id }), null);
  assert.equal(await invoke({ operation: 'get', taskId: foreignLegacy.id }), null);
  assert.equal(await invoke({ operation: 'getBySubject', subjectKey: 'foreign:subject' }), null);
  assert.deepEqual(await invoke({ operation: 'list', threadId: thread.id }), [readTask]);
  assert.deepEqual(await invoke({ operation: 'listByKind', kind: 'work' }), [readTask]);

  const updated = await invoke({ operation: 'update', taskId: created.id, patch: { status: 'doing' } });
  assert.equal(updated.status, 'doing');
  assert.equal((await taskStore.listByThread(thread.id))[0]?.status, 'doing');

  const tracking = await invoke({
    operation: 'upsertBySubject',
    threadId: thread.id,
    title: 'Track pull request',
    why: 'Fixture tracking task',
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#42',
  });
  assert.equal((await invoke({ operation: 'getBySubject', subjectKey: 'pr:owner/repo#42' })).id, tracking.id);
  assert.deepEqual(
    (await invoke({ operation: 'listByKind', kind: 'pr_tracking' })).map((task) => task.id),
    [tracking.id],
  );
  const upserted = await invoke({
    operation: 'upsertBySubject',
    threadId: 'thread-plugin-task-updated',
    title: 'Track pull request (updated)',
    why: 'Idempotent fixture tracking task',
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#42',
  });
  assert.equal(upserted.id, tracking.id);
  assert.equal(upserted.threadId, 'thread-plugin-task-updated');

  assert.equal(
    await invoke({
      operation: 'updateIfThreadId',
      taskId: tracking.id,
      expectedThreadId: 'thread-plugin-task',
      patch: { threadId: 'thread-stale-overwrite' },
    }),
    null,
    'a stale routing repair must not overwrite a task moved by another actor',
  );
  const conditionallyUpdated = await invoke({
    operation: 'updateIfThreadId',
    taskId: tracking.id,
    expectedThreadId: 'thread-plugin-task-updated',
    patch: { threadId: 'thread-plugin-task-repaired' },
  });
  assert.equal(conditionallyUpdated.threadId, 'thread-plugin-task-repaired');
});
