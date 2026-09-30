import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPluginThreadHost;
let ThreadStore;
let MemoryConnectorThreadBindingStore;

const OWNER = 'owner-1';
const PROJECT_ROOT = '/workspace/clowder-ai';

beforeEach(async () => {
  ({ createPluginThreadHost } = await import('../dist/domains/plugin/host-surface/plugin-thread-host.js'));
  ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  ({ MemoryConnectorThreadBindingStore } = await import(
    '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js'
  ));
});

function hostOf(options = {}) {
  const threadStore = options.threadStore ?? new ThreadStore();
  const bindingStore = options.bindingStore ?? new MemoryConnectorThreadBindingStore();
  const host = createPluginThreadHost({
    pluginId: options.pluginId ?? 'dev.clowder.fixture',
    pluginInstanceId: options.pluginInstanceId ?? 'instance-1',
    ownerUserId: OWNER,
    projectPath: options.projectPath ?? PROJECT_ROOT,
    effectiveGrants: options.effectiveGrants ?? ['thread.listMetadata', 'thread.readContent', 'thread.write'],
    threadStore,
    bindingStore,
    systemThreadTitle: options.systemThreadTitle ?? 'Fixture',
  });
  return { host, threadStore, bindingStore };
}

describe('F202 C1 — plugin Host thread surface', () => {
  test('all thread mutations require the thread.write grant', async () => {
    const { host, threadStore } = hostOf({ effectiveGrants: ['thread.listMetadata', 'thread.readContent'] });
    const existing = await threadStore.create(OWNER, 'Existing');

    await assert.rejects(() => host.create({ title: 'Denied' }), /lacks thread\.write/);
    await assert.rejects(() => host.update(existing.id, { title: 'Denied' }), /lacks thread\.write/);
    await assert.rejects(() => host.ensureByKey('denied', { title: 'Denied' }), /lacks thread\.write/);
    await assert.rejects(() => host.bind('denied', existing.id), /lacks thread\.write/);
    await assert.rejects(() => host.unbind('denied'), /lacks thread\.write/);
    await assert.rejects(() => host.ensureSystemThread(), /lacks thread\.write/);
  });

  test('concurrent ensureByKey converges on one persistent plugin-owned thread', async () => {
    const { host, threadStore } = hostOf();

    const [first, second] = await Promise.all([
      host.ensureByKey('group-42', { title: 'Group 42' }),
      host.ensureByKey('group-42', { title: 'Group 42' }),
    ]);

    assert.equal(first.id, second.id);
    assert.deepEqual(await host.findByKey('group-42'), first);
    const bindings = await host.listBindings();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].key, 'group-42');
    assert.equal(bindings[0].threadId, first.id);
    assert.equal(typeof bindings[0].createdAt, 'number');
    assert.deepEqual((await threadStore.get(first.id))?.pluginOwnership, {
      v: 1,
      pluginInstanceId: 'instance-1',
    });
    assert.equal((await threadStore.list(OWNER)).filter((thread) => thread.id === first.id).length, 1);
  });

  test('the same external key is isolated by the Host-bound plugin id', async () => {
    const threadStore = new ThreadStore();
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const first = hostOf({ pluginId: 'dev.clowder.first', pluginInstanceId: 'first-1', threadStore, bindingStore });
    const second = hostOf({ pluginId: 'dev.clowder.second', pluginInstanceId: 'second-1', threadStore, bindingStore });

    const firstThread = await first.host.ensureByKey('same-key', { title: 'First' });
    const secondThread = await second.host.ensureByKey('same-key', { title: 'Second' });

    assert.notEqual(firstThread.id, secondThread.id);
    assert.equal((await first.host.findByKey('same-key'))?.id, firstThread.id);
    assert.equal((await second.host.findByKey('same-key'))?.id, secondThread.id);
  });

  test('the fixed system thread is stable and plugin-owned', async () => {
    const { host, threadStore } = hostOf();

    const first = await host.ensureSystemThread();
    const second = await host.ensureSystemThread();

    assert.equal(first.id, second.id);
    assert.deepEqual((await threadStore.get(first.id))?.pluginOwnership, {
      v: 1,
      pluginInstanceId: 'instance-1',
    });
  });

  test('a reinstalled plugin recovers its bound and system threads and can update them', async () => {
    const threadStore = new ThreadStore();
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const bound = await threadStore.ensureThread('legacy-bound-thread', 'Before reinstall');
    const system = await threadStore.ensureThread('legacy-system-thread', 'Legacy system');
    await threadStore.updatePluginOwnership(bound.id, { v: 1, pluginInstanceId: 'instance-before-reinstall' });
    await threadStore.updatePluginOwnership(system.id, { v: 1, pluginInstanceId: 'instance-before-reinstall' });
    await bindingStore.bind('dev.clowder.fixture', 'group-42', bound.id, OWNER);
    await bindingStore.bind('dev.clowder.fixture', '__plugin_system_thread__', system.id, OWNER);

    const reinstalled = hostOf({ pluginInstanceId: 'instance-after-reinstall', threadStore, bindingStore });

    assert.equal((await reinstalled.host.findByKey('group-42'))?.id, bound.id);
    assert.equal((await reinstalled.host.ensureByKey('group-42', { title: 'Ignored' })).id, bound.id);
    assert.equal((await reinstalled.host.ensureSystemThread()).id, system.id);
    assert.equal((await reinstalled.host.update(bound.id, { title: 'After reinstall' })).title, 'After reinstall');
  });

  test('unbind followed by ensure creates a fresh owner thread in the Host project', async () => {
    const { host, threadStore } = hostOf();
    const first = await host.ensureByKey('group-42', { title: 'First binding' });

    assert.equal(await host.unbind('group-42'), true);
    const second = await host.ensureByKey('group-42', { title: 'Second binding' });

    assert.notEqual(second.id, first.id);
    const stored = await threadStore.get(second.id);
    assert.equal(stored?.createdBy, OWNER);
    assert.equal(stored?.projectPath, PROJECT_ROOT);
  });

  test('create stores the owner and Host project path instead of default placeholders', async () => {
    const { host, threadStore } = hostOf();

    const created = await host.create({ title: 'Owned by operator' });
    const stored = await threadStore.get(created.id);

    assert.equal(stored?.createdBy, OWNER);
    assert.equal(stored?.projectPath, PROJECT_ROOT);
  });

  test('reads are grant-gated and one plugin cannot mutate another plugin-owned thread', async () => {
    const threadStore = new ThreadStore();
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const owner = hostOf({ pluginId: 'dev.clowder.owner', pluginInstanceId: 'owner-1', threadStore, bindingStore });
    const stranger = hostOf({
      pluginId: 'dev.clowder.stranger',
      pluginInstanceId: 'stranger-1',
      threadStore,
      bindingStore,
    });
    const noRead = hostOf({
      pluginId: 'dev.clowder.no-read',
      pluginInstanceId: 'no-read-1',
      effectiveGrants: [],
      threadStore,
      bindingStore,
    });
    const thread = await owner.host.create({ title: 'Owned' });

    await assert.rejects(() => stranger.host.update(thread.id, { title: 'Stolen' }), /does not own thread/);
    await assert.rejects(() => noRead.host.get(thread.id), /lacks thread\.readContent/);
    assert.equal((await owner.host.get(thread.id))?.title, 'Owned');
  });

  test('binding an owner thread does not turn it into plugin-owned state', async () => {
    const { host, threadStore } = hostOf();
    const existing = await threadStore.create(OWNER, 'Existing');

    await host.bind('selected-thread', existing.id);

    assert.equal((await host.findByKey('selected-thread'))?.id, existing.id);
    assert.equal((await threadStore.get(existing.id))?.pluginOwnership, undefined);
    assert.equal(await host.unbind('selected-thread'), true);
    assert.equal(await host.findByKey('selected-thread'), null);
  });
});
