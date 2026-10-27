import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { withCurrentOwnerOperation } from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { neutralFixture } from './helpers/neutral-host-fixture.js';
import { catalogEntry } from './plugin-official-package-installer.fixture.js';

async function fixture(t, options = {}) {
  const f = await neutralFixture(t, {
    configuration: true,
    members: {
      listCats: () => [{ catId: 'codex', displayName: 'Codex', defaultModel: 'model' }],
      isCatAvailable: () => true,
      publicAvatar: async () => undefined,
    },
    threadProjections: { cats: { getAllCatIds: () => ['codex'], isCatAvailable: () => true } },
    ...options,
  });
  // Direct fixture startup needs the same successful-runtime projection as enable.
  await f.runtime.inventoryStore.transaction((tx) => {
    const i = tx.instances.get(f.installed.pluginInstanceId);
    tx.instances.put({ ...i, runtimeState: 'healthy' });
  });
  const pkg = (await f.runtime.inventoryStore.snapshot()).packages[0];
  const entry = catalogEntry(pkg.packageDigest, {
    pluginId: pkg.pluginId,
    version: pkg.manifest.version,
  });
  const { manager } = createPluginManagerRuntimeComposition({
    runtime: f.runtime,
    catalogManifests: [pkg.manifest],
    catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 1 }) },
  });
  const save = async (label) => {
    const before = (await manager.get('dev.clowder.neutral-host')).plugin;
    await manager.configure('dev.clowder.neutral-host', {
      expectedRevision: before.lifecycleRevision,
      updates: [{ key: 'label', value: label }],
    });
    const after = (await manager.get('dev.clowder.neutral-host')).plugin;
    assert.equal(after.lifecycleRevision, before.lifecycleRevision + 1);
    assert.equal(after.live, 'running');
    assert.equal(f.events.filter((x) => x === 'start').length, 1, 'refresh must not recreate the client');
    assert.equal(f.events.includes('stop'), false);
  };
  return { ...f, save, manager };
}

test('real configure keeps members live on the same activation', async (t) => {
  let duringRefresh;
  const f = await fixture(t, {
    onRefresh: async (host) => {
      duringRefresh = await host.members.list();
    },
  });
  const host = f.host();
  const check = async () => {
    assert.equal((await host.members.list())[0].catId, 'codex');
    assert.ok(
      await f.runtime.supervisor.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: f.installed.pluginInstanceId,
        contributionId: 'native',
      }),
    );
  };
  await check();
  await f.save('updated');
  await check();
  assert.equal(duringRefresh[0].catId, 'codex');
  assert.equal(f.host(), host);
  await f.runtime.shutdown('test_stop');
  await assert.rejects(host.members.list(), /current/);
});

test('real configure keeps entrusted Task data mutations live and stop revokes retained client', async (t) => {
  const tasks = new TaskStore();
  const f = await fixture(t, { taskStore: tasks });
  f.threads.addParticipants(f.thread.id, ['codex']);
  const source = f.messages.append({
    userId: f.owner,
    threadId: f.thread.id,
    from: { kind: 'plugin', instanceId: f.installed.pluginInstanceId },
    content: 'Produce report',
    timestamp: 1,
    extra: {
      pluginMessage: {
        instanceId: f.installed.pluginInstanceId,
        revision: 1,
        provenance: {},
        elements: [],
        appendOps: [],
      },
    },
  });
  const input = {
    threadId: f.thread.id,
    title: 'Report',
    kind: 'work',
    subjectKey: 'refresh:report',
    ownerCatId: 'codex',
    entrustedWork: {
      sourceMessageId: source.id,
      intendedOutcome: 'A report',
      closure: { condition: 'Accepted', expectedSignal: 'accepted' },
      time: { businessDeadline: { value: 1900000000000, sourceRef: `message:${source.id}` } },
    },
  };
  const host = f.host();
  const task = await host.tasks.create(input, { onConflict: 'update' });
  assert.ok(task.subjectKey);
  assert.ok(task.ownerCatId);
  assert.ok(task.entrustedWork?.admission.authorityRef);
  const bound = await withCurrentOwnerOperation(
    {
      kind: 'owner-operation',
      userId: f.owner,
      pluginInstanceId: f.installed.pluginInstanceId,
      operationKey: 'work',
      actionId: 'bind-before-config-refresh',
      requestId: 'config-refresh-controller-binding',
      confirmed: true,
      signal: new AbortController().signal,
      assertWriteCurrent: () => {},
      assertCurrent: async () => {},
    },
    () =>
      host.tasks.bindDataController({
        taskId: task.id,
        expectedTaskRevision: task.entrustedWork.revision,
        operationId: 'bind-before-config-refresh',
        expected: {
          ownerCatId: task.ownerCatId,
          threadId: task.threadId,
          subjectKey: task.subjectKey,
          firstSourceRef: `message:${source.id}`,
          admissionAuthorityRef: task.entrustedWork.admission.authorityRef,
        },
      }),
  );
  assert.equal(bound.task.entrustedWork.dataController.currentForCaller, true);
  await f.save('updated');
  const refreshed = await host.tasks.get({ id: task.id });
  assert.equal(refreshed.entrustedWork.dataController.currentForCaller, true);
  assert.equal((await host.tasks.create(input, { onConflict: 'update' })).id, task.id);
  const updated = await host.tasks.update(task.id, {
    entrustedWork: {
      expectedRevision: refreshed.entrustedWork.revision,
      time: { businessDeadline: { value: 1900000100000, sourceRef: `message:${source.id}` } },
    },
  });
  assert.equal(updated.entrustedWork.time.businessDeadline.value, 1900000100000);
  await f.runtime.shutdown('test_stop');
  await assert.rejects(host.tasks.create(input, { onConflict: 'update' }), /current/);
});

for (const surface of ['action', 'launch']) {
  test(`real configure keeps native MCP ${surface} on its existing connection`, async (t) => {
    const f = await fixture(t, []);
    const call = () =>
      surface === 'action'
        ? f.native('missing', 'read')
        : f.runtime.supervisor.resolveNativeMcpLaunch({
            mode: 'plugin_native',
            pluginInstanceId: f.installed.pluginInstanceId,
            contributionId: 'native',
          });
    const before = await call();
    await f.save('updated');
    assert.deepEqual(await call(), before);
    await f.runtime.shutdown('test_stop');
    await assert.rejects(call());
  });
}
