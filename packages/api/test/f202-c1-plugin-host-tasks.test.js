import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/plugin-task-host.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

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
      "              if (operation === 'get') return host.tasks.get(input.taskId);",
      "              if (operation === 'list') return host.tasks.listByThread(input.threadId);",
      "              if (operation === 'listByKind') return host.tasks.listByKind(input.kind);",
      "              if (operation === 'getBySubject') return host.tasks.getBySubject(input.subjectKey);",
      "              if (operation === 'upsertBySubject') return host.tasks.upsertBySubject(input);",
      "              if (operation === 'updateIfThreadId') return host.tasks.updateIfThreadId(input.taskId, input.expectedThreadId, input.patch);",
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

test('module plugin task reads and writes require their respective grants', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-task-grants-project-');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    taskStore: new TaskStore(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeTaskFixture([]) },
  });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });

  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.tasks', {
      operation: 'get',
      taskId: 'task-denied',
    }),
    /lacks task\.read/,
  );
  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.tasks', {
      operation: 'create',
      threadId: 'thread-denied',
      title: 'Denied',
    }),
    /lacks task\.write/,
  );
});

test('task grants are checked before Host task-store availability', async () => {
  const denied = createPluginTaskHost({ pluginId: 'dev.clowder.denied', effectiveGrants: [], taskStore: undefined });
  await assert.rejects(() => denied.get('task-1'), /lacks task\.read/);

  const unavailable = createPluginTaskHost({
    pluginId: 'dev.clowder.authorized',
    effectiveGrants: ['task.read'],
    taskStore: undefined,
  });
  await assert.rejects(() => unavailable.get('task-1'), /Host task store is unavailable/);
});

test('module plugins create, read, and update ordinary tasks through the Host task store', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-task-project-');
  const taskStore = new TaskStore();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    taskStore,
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: () => ['task.read', 'task.write'],
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
    threadId: 'thread-plugin-task',
    title: 'Inspect a migrated notification',
    why: 'Created by an installed plugin through the ordinary task store',
    kind: 'work',
  });
  assert.equal(created.threadId, 'thread-plugin-task');
  assert.equal(created.createdBy, 'system', 'the Host, not package code, owns the persisted task principal');
  assert.deepEqual(await invoke({ operation: 'get', taskId: created.id }), created);
  assert.deepEqual(await invoke({ operation: 'list', threadId: 'thread-plugin-task' }), [created]);

  const updated = await invoke({ operation: 'update', taskId: created.id, patch: { status: 'doing' } });
  assert.equal(updated.status, 'doing');
  assert.equal((await taskStore.listByThread('thread-plugin-task'))[0]?.status, 'doing');

  const tracking = await invoke({
    operation: 'upsertBySubject',
    threadId: 'thread-plugin-task',
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
