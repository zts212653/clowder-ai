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

test('real message ingress admits mixed member/plugin targets, rejects unknowns and keeps whispers member-only', async () => {
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
  const inventory = new MemoryPluginInventoryStore(snapshot(), { contract });
  const targets = service(inventory);
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner';
  const thread = await threadStore.create(owner, 'Plugin addressing');
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('opus', {} as never);
  const router = new AgentRouter({
    agentRegistry,
    registry,
    messageStore,
    threadStore,
    addressedPlugins: targets,
  });
  assert.deepEqual(await router.resolveExplicitTargets(['opus', 'pi_original'], thread.id), ['opus', 'pi_original']);
  const queue = new InvocationQueue(undefined, {
    resolveTargetKinds: (requested) => router.resolveQueueTargetKinds(requested),
    resolvePreResolvedTargets: (requested, implicit) => router.resolveAdmissionTargets(requested, implicit),
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
      payload: {
        threadId: thread.id,
        content: '@assistant-2 help',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual((await queue.listAllDurable(thread.id))[0]?.targets, ['pi_original']);
    assert.deepEqual((await threadStore.get(thread.id))?.participants, ['pi_original']);
    await targets.configure('pi_original', { alias: 'renamed', expectedRevision: 1 });
    assert.deepEqual((await queue.listAllDurable(thread.id))[0]?.targets, ['pi_original']);
    const mixed = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        threadId: thread.id,
        content: 'mixed explicit delivery',
        mentions: ['opus', 'pi_original'],
      },
    });
    assert.equal(mixed.statusCode, 202, mixed.body);
    assert.ok(
      (await queue.listAllDurable(thread.id)).some(
        (entry) => entry.targets.length === 2 && entry.targets[0] === 'opus' && entry.targets[1] === 'pi_original',
      ),
    );
    const mixedUnknown = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        threadId: thread.id,
        content: 'mixed invalid delivery',
        mentions: ['opus', 'pi_original', 'not-a-target'],
      },
    });
    assert.equal(mixedUnknown.statusCode, 400, mixedUnknown.body);
    assert.equal(mixedUnknown.json().code, 'INVALID_EXPLICIT_TARGETS');
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
    const { AddressedPluginQueueDelivery } = await import(
      '../src/domains/plugin/manager/addressing/addressed-plugin-queue-delivery.js'
    );
    let delivered = 0;
    const delivery = new AddressedPluginQueueDelivery({
      targets,
      queue,
      messageStore,
      manager: {
        deliverAddressed: async (id, input) => {
          assert.equal(id, 'pi_original');
          delivered++;
          return { deliveryId: input.deliveryId };
        },
      } as never,
    });
    const first = (await queue.listAllDurable(thread.id))[0]!;
    const claimed = await queue.markProcessingByIdDurable(thread.id, first.id, 'pi_original');
    assert.ok(claimed);
    await delivery.deliver(claimed, 'pi_original');
    await delivery.deliver(claimed, 'pi_original');
    assert.equal(delivered, 1, 'the accepted source has one durable delivery receipt');
    await inventory.transaction((tx) => {
      const old = tx.instances.get('pi_original')!;
      tx.instances.put({ ...old, lifecycleState: 'retired', retiredAt: 10 });
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        threadId: thread.id,
        content: '@assistant-2 help',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().userMessageId, response.json().userMessageId);
    assert.equal(delivered, 1);
    const retired = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { threadId: thread.id, content: 'new work', mentions: ['pi_original'] },
    });
    assert.equal(retired.statusCode, 400, retired.body);
  } finally {
    await app.close();
  }
});

test('server-classified plugin targets work through durable wake, existing-message and target expansion admissions', async () => {
  const [{ InvocationQueue }, { MessageStore }] = await Promise.all([
    import('../src/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../src/domains/cats/services/stores/ports/MessageStore.js'),
  ]);
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry: {} as never,
    messageStore: {} as never,
    addressedPlugins: service(),
  });
  const queue = new InvocationQueue(undefined, {
    resolveTargetKinds: (requested) => router.resolveQueueTargetKinds(requested),
    resolvePreResolvedTargets: (requested, implicit) => router.resolveAdmissionTargets(requested, implicit),
  });
  const store = new MessageStore();
  const from = { kind: 'user', userId: 'owner' } as const;
  const source = store.append({
    userId: 'owner',
    threadId: 'thread',
    from,
    content: 'plugin work',
    mentions: [],
    timestamp: 1,
    deliveryStatus: 'queued',
  });
  const input = {
    userId: 'owner',
    threadId: 'thread',
    from,
    content: source.content,
    targetCats: ['pi_original'],
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    intent: 'execute',
  } as const;
  const admitted = await queue.enqueueExistingMessageDurable(store, source.id, {
    ...input,
    targetCats: [...input.targetCats],
  });
  assert.equal(admitted.outcome, 'enqueued');
  assert.deepEqual(admitted.outcome === 'enqueued' && admitted.entries[0]?.targets, ['pi_original']);
  const wake = await queue.enqueueDurable({
    ...input,
    targetCats: ['pi_original'],
    messageId: source.id,
    kind: 'message_wake',
    sourceId: 'wake',
  });
  assert.deepEqual(wake.entries?.[0]?.targets, ['pi_original']);
  const expansionSource = store.append({
    userId: 'owner',
    threadId: 'thread',
    from,
    content: input.content,
    mentions: [],
    timestamp: 2,
    deliveryStatus: 'queued',
  });
  const anchor = await queue.enqueueExistingMessageDurable(store, expansionSource.id, { ...input, targetCats: [] });
  assert.ok(anchor.outcome === 'enqueued' && anchor.entries?.[0]);
  if (anchor.outcome !== 'enqueued') throw new Error('anchor not admitted');
  const expanded = await queue.mapQueuedMessageTargetsDurable(
    store,
    expansionSource.id,
    anchor.entries[0].id,
    'pi_original',
    [anchor.entries[0].id],
    { ...input, targetCats: ['pi_original'] },
  );
  assert.ok(['expanded', 'replayed'].includes(expanded.outcome));
  await assert.rejects(
    queue.enqueueDurable({
      ...input,
      targetCats: ['pi_original', 'unknown'],
      messageId: source.id,
      sourceId: 'unknown',
    }),
    /target/i,
  );
});

test('mixed targets reject atomically when a member becomes unavailable after async routing', async () => {
  const [{ InvocationQueue }, { MessageStore }] = await Promise.all([
    import('../src/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../src/domains/cats/services/stores/ports/MessageStore.js'),
  ]);
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry: {} as never,
    messageStore: {} as never,
    addressedPlugins: service(),
  });
  let disabled = false;
  const queue = new InvocationQueue(undefined, {
    resolveTargetKinds: (requested) => router.resolveQueueTargetKinds(requested),
    resolveTargets: async (requested) => {
      disabled = true;
      return [...requested];
    },
    resolvePreResolvedTargets: (requested, implicit) =>
      disabled && requested.includes('opus') ? [] : router.resolveAdmissionTargets(requested, implicit),
  });
  const store = new MessageStore();
  const from = { kind: 'user', userId: 'owner' } as const;
  await assert.rejects(
    queue.send(
      store,
      {
        userId: 'owner',
        threadId: 'thread',
        from,
        content: 'mixed work',
        mentions: ['opus', 'pi_original'] as never,
        timestamp: 1,
        deliveryStatus: 'queued',
      },
      {
        userId: 'owner',
        threadId: 'thread',
        from,
        content: 'mixed work',
        targetCats: ['opus', 'pi_original'],
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        intent: 'execute',
      },
    ),
    /target/i,
  );
  assert.deepEqual(store.getByThread('thread'), []);
  assert.deepEqual(await queue.listAllDurable('thread'), []);
});
