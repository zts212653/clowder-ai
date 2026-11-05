import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { analyzeA2AMentions } from '../src/domains/cats/services/agents/routing/a2a-mentions.js';
import { FilePluginInventoryStore, MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { PluginAddressedTargets } from '../src/domains/plugin/manager/addressing/plugin-addressed-targets.js';
import { PluginManagerService } from '../src/domains/plugin/manager/plugin-manager-service.js';

const digest = `sha512-${createHash('sha512').update('addressed-fixture').digest('base64')}`;
// The public schema delta is supplied by the package workstream. These tests
// exercise Host inventory/presentation, independently of package verification.
const contract = {
  manifestContractRange: '0.1.0',
  validateManifest: (manifest: unknown) => ({ valid: true as const, manifest: manifest as never, errors: [] }),
};
function snapshot(addressed = true) {
  return {
    schemaVersion: 1,
    packages: [
      {
        packageDigest: digest,
        pluginId: 'example.assistant',
        version: '1.0.0',
        contractVersion: '0.1.0',
        manifest: {
          pluginId: 'example.assistant',
          version: '1.0.0',
          contractVersion: '0.1.0',
          name: 'Assistant',
          features: [],
          ...(addressed ? { call: { alias: 'assistant', displayName: 'Assistant' } } : {}),
        },
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId: 'pi_original',
        pluginId: 'example.assistant',
        packageDigest: digest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
  };
}
function service(store = new MemoryPluginInventoryStore(snapshot(), { contract })) {
  return new PluginAddressedTargets({
    inventory: store,
    memberAliases: () => ['@assistant', 'member-id', '@codex'],
  });
}

test('explicit addressed declaration generates and persists a unique alias, without inventing a member', async () => {
  const store = new MemoryPluginInventoryStore(snapshot(), { contract });
  const targets = service(store);
  const [target] = await targets.list();
  assert.equal(target?.kind, 'plugin');
  assert.equal(target?.id, 'pi_original');
  assert.equal(target?.alias, 'assistant-2');
  assert.equal((await store.snapshot()).instances[0]?.address?.alias, 'assistant-2');
  assert.deepEqual(await targets.list(), [target]);
});

test('a single declared identity becomes the generic default address when its alias is free', async () => {
  const state = snapshot();
  const pkg = state.packages[0];
  assert.ok(pkg);
  pkg.manifest.call = { alias: 'dot', displayName: 'Dot' };
  pkg.manifest.contributions = [{ type: 'identity', id: 'dot', displayName: 'Dot' }];
  const targets = service(new MemoryPluginInventoryStore(state, { contract }));

  assert.equal((await targets.list())[0]?.alias, 'dot');
});

test('an IM delivery action/subscription without opt-in is not addressable', async () => {
  const targets = service(new MemoryPluginInventoryStore(snapshot(false), { contract }));
  assert.deepEqual(await targets.list(), []);
  assert.equal(await targets.resolve('pi_original'), undefined);
});

test('rename preserves stable identity, rejects member collisions and fences concurrent edits', async () => {
  const targets = service();
  const [before] = await targets.list();
  await assert.rejects(targets.configure('pi_original', { alias: 'CODEX', expectedRevision: 1 }), /alias.*use/i);
  await targets.configure('pi_original', { alias: 'helper', icon: '/uploads/helper.png', expectedRevision: 1 });
  assert.equal((await targets.resolve('@helper'))?.id, before?.id);
  assert.equal(await targets.resolve('@assistant-2'), undefined);
  assert.equal((await targets.resolve('pi_original'))?.alias, 'helper');
  await assert.rejects(targets.configure('pi_original', { alias: 'later', expectedRevision: 1 }), /revision/i);
});

test('disabled and uninstalled instances are not delivery targets; disabled aliases remain reserved', async () => {
  const store = new MemoryPluginInventoryStore(snapshot(), { contract });
  const targets = service(store);
  await targets.list();
  await store.transaction((tx) => {
    const instance = tx.instances.get('pi_original')!;
    tx.instances.put({ ...instance, activationState: 'disabled', runtimeState: 'stopped' });
  });
  assert.deepEqual(await targets.list(), []);
  assert.equal(await targets.resolve('pi_original'), undefined);
  assert.equal(await targets.aliasInUse('assistant-2'), true);
  await store.transaction((tx) => {
    const instance = tx.instances.get('pi_original')!;
    tx.instances.put({ ...instance, lifecycleState: 'retired', retiredAt: 10 });
  });
  assert.equal(await targets.resolve('pi_original'), undefined);
  await store.transaction((tx) => {
    const old = tx.instances.get('pi_original')!;
    const { address: _address, retiredAt: _retiredAt, ...base } = old;
    tx.instances.put({
      ...base,
      pluginInstanceId: 'pi_reinstalled',
      lifecycleState: 'installed',
      activationState: 'enabled',
    });
  });
  assert.equal((await targets.resolve('@assistant-2'))?.id, 'pi_reinstalled');
  assert.equal(
    await targets.resolve('pi_original'),
    undefined,
    'a queued retired ID never follows the reclaimed alias',
  );
  assert.equal(await targets.isInstanceId('pi_original'), true);
});

test('address survives an actual inventory file round trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'addressed-target-test-'));
  try {
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path, { contract });
    await store.transaction((tx) => {
      const data = snapshot();
      for (const p of data.packages) tx.packages.put(p as never);
      for (const i of data.instances) tx.instances.put(i as never);
    });
    await service(store).list();
    await service(store).configure('pi_original', { alias: 'helper', expectedRevision: 1 });
    const reopened = new FilePluginInventoryStore(path, { contract });
    assert.equal((await service(reopened).resolve('@helper'))?.id, 'pi_original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary admission freezes a plugin instance; rename cannot redirect the queued recipient', async () => {
  const targets = service();
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry: {} as never,
    messageStore: {} as never,
    addressedPlugins: targets,
  });
  const parsed = await router.resolveTargetsAndIntent('Please @assistant-2 help', 't', { allowFallback: false });
  assert.deepEqual(parsed.targetCats, ['pi_original']);
  assert.deepEqual(await router.resolveExplicitTargets(['pi_original'], 't'), ['pi_original']);
  await targets.configure('pi_original', { alias: 'helper', expectedRevision: 1 });
  assert.deepEqual(await router.resolveConversationTargetsAtAdmission(parsed.targetCats, 't'), ['pi_original']);
  const renamed = await router.resolveTargetsAndIntent('@helper', 't', { allowFallback: false });
  assert.deepEqual(renamed.targetCats, ['pi_original']);
});

test('A2A includes explicit plugin targets but keeps line-start and code-fence rules', async () => {
  const targets = await service().list();
  assert.deepEqual(analyzeA2AMentions('@assistant-2\nplease help', undefined, targets).mentions, ['pi_original']);
  assert.deepEqual(analyzeA2AMentions('talk about @assistant-2', undefined, targets).mentions, []);
  assert.deepEqual(analyzeA2AMentions('```\n@assistant-2\n```', undefined, targets).mentions, []);
});

test('Manager delivery checks exact instance, live opt-in and receipt identity each time', async () => {
  const inventory = new MemoryPluginInventoryStore(snapshot(), { contract });
  const targets = service(inventory);
  const calls: unknown[][] = [];
  let mismatched = false;
  const manager = new PluginManagerService({
    catalog: { snapshot: async () => ({ candidates: [], status: 'fresh', refreshedAt: 1 }) },
    inventory,
    addressedTargets: targets,
    delivery: {
      deliver: async (...args) => {
        calls.push(args);
        return { deliveryId: mismatched ? 'wrong' : (args[1] as { deliveryId: string }).deliveryId };
      },
    },
  });
  const input = {
    kind: 'message' as const,
    reason: 'addressed' as const,
    deliveryId: 'd1',
    threadId: 't',
    envelope: {} as never,
  };
  await targets.list();
  await manager.deliverAddressed('pi_original', input);
  assert.deepEqual(calls[0], ['pi_original', input]);
  await assert.rejects(manager.deliverAddressed('assistant-2', input), /unavailable/);
  mismatched = true;
  await assert.rejects(manager.deliverAddressed('pi_original', input), /receipt mismatch/);
  await inventory.transaction((tx) => {
    tx.instances.put({ ...tx.instances.get('pi_original')!, activationState: 'disabled' });
  });
  await assert.rejects(manager.deliverAddressed('pi_original', input), /unavailable/);
  assert.equal(calls.length, 2);
});

test('plugin aliases cannot capture existing group or owner mention syntax', async () => {
  const targets = service();
  await targets.list();
  for (const alias of ['all', 'thread', '全体', '本帖', '全体布偶猫', 'all-ragdoll', 'co-creator']) {
    await assert.rejects(targets.configure('pi_original', { alias, expectedRevision: 1 }), /reserved/i);
  }
});

test('disabled explicit plugin input has no member fallback; group/implicit routes stay member-only', async () => {
  const inventory = new MemoryPluginInventoryStore(snapshot(), { contract });
  const targets = service(inventory);
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('opus', {} as never);
  const router = new AgentRouter({
    agentRegistry,
    registry: {} as never,
    messageStore: {} as never,
    addressedPlugins: targets,
  });
  await targets.list();
  for (const text of ['@all', '@thread', 'continue']) {
    const preview = await router.previewTargets(text, { threadId: 't' });
    assert.equal(preview.targetCats.includes('pi_original' as never), false);
  }
  await inventory.transaction((tx) =>
    tx.instances.put({ ...tx.instances.get('pi_original')!, activationState: 'disabled' }),
  );
  assert.deepEqual(await router.resolveSendTargets([], 't', '@assistant-2 help'), ['pi_original']);
  assert.deepEqual(await router.resolveConversationTargetsAtAdmission(['pi_original'], 't'), []);
  const preview = await router.previewTargets('@assistant-2 help', { threadId: 't' });
  assert.deepEqual(preview.targetCats, []);
  assert.deepEqual(preview.unavailableTargets, ['pi_original']);
  const mixed = await router.previewTargets('@opus @assistant-2 help', { threadId: 't' });
  assert.deepEqual(mixed.targetCats, ['opus']);
  assert.deepEqual(mixed.unavailableTargets, ['pi_original']);
  assert.equal((await targets.known())[0]?.alias, 'assistant-2');
});

test('address edits do not change activation revision; icon can be restored and arbitrary URLs are rejected', async () => {
  const targets = service();
  await targets.list();
  await targets.configure('pi_original', { alias: 'helper', icon: '/uploads/helper.png', expectedRevision: 1 });
  await targets.configure('pi_original', { alias: 'helper', icon: null, expectedRevision: 2 });
  const [target] = await targets.list();
  assert.equal(target?.lifecycleRevision, 1);
  assert.equal(target?.addressRevision, 3);
  assert.equal(target?.icon, undefined);
  await assert.rejects(
    targets.configure('pi_original', { alias: 'helper', icon: 'https://tracking.example/img', expectedRevision: 3 }),
    /avatar/i,
  );
});

test('real message ingress binds plugin identity as a participant and rejects plugin whispers', async () => {
  const [
    { default: Fastify },
    { messagesRoutes },
    { MessageStore },
    { ThreadStore },
    { InvocationRegistry },
    { InvocationQueue },
  ] = await Promise.all([
    import('fastify'),
    import('../src/routes/messages.js'),
    import('../src/domains/cats/services/stores/ports/MessageStore.js'),
    import('../src/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../src/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../src/domains/cats/services/agents/invocation/InvocationQueue.js'),
  ]);
  const targets = service();
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner';
  const thread = await threadStore.create(owner, 'Plugin addressing');
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry,
    messageStore,
    threadStore,
    addressedPlugins: targets,
  });
  const queue = new InvocationQueue(undefined, {
    resolveTargets: (requested, threadId, content, exact) =>
      router.resolveSendTargets(requested, threadId, content, exact),
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    (request as typeof request & { sessionUserId: string }).sessionUserId = owner;
  });
  await app.register(messagesRoutes, {
    registry,
    router,
    messageStore,
    threadStore,
    invocationQueue: queue,
    queueProcessor: { requestDrain: async () => {} } as never,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} } as never,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { threadId: thread.id, content: '@assistant-2 help' },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual((await queue.listAllDurable(thread.id))[0]?.targets, ['pi_original']);
    assert.deepEqual((await threadStore.get(thread.id))?.participants, ['pi_original']);
    await targets.configure('pi_original', { alias: 'renamed', expectedRevision: 1 });
    assert.deepEqual((await queue.listAllDurable(thread.id))[0]?.targets, ['pi_original']);
    const whisper = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        threadId: thread.id,
        content: 'secret',
        visibility: 'whisper',
        whisperTo: ['pi_original'],
      },
    });
    assert.equal(whisper.statusCode, 400, whisper.body);
  } finally {
    await app.close();
  }
});
