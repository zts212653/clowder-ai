import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDescriptor } from '@clowder-ai/plugin-memory-contract';
import Fastify from 'fastify';
import { createMemoryIndexSources } from '../dist/domains/cats/services/session/memory-index-sources.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createEventMemoryProvider } from '../dist/domains/plugin/host-surface/event-memory-provider.js';
import { MemoryPluginHost } from '../dist/domains/plugin/host-surface/memory-plugin-host.js';
import { createMemorySourceHost } from '../dist/domains/plugin/host-surface/memory-source-host.js';
import { eventsRoutes } from '../dist/routes/events.js';
import { memoryRoutes } from '../dist/routes/memory.js';
import { createMatterRouteProvider, readMatterOpeningPrompt } from '../dist/routes/memory-matter-provider.js';
import { registerCallbackMatterMemoryRoutes } from '../dist/routes/memory-matter-routes.js';
import { createMemoryRouteProvider } from '../dist/routes/memory-route-provider.js';

const pluginInstanceId = 'approved-memory-instance';
const admission = {
  instance: { pluginInstanceId },
  packageRecord: {
    pluginId: 'official.memory',
    provenance: { kind: 'catalog', catalogId: 'official.memory', packageName: '@clowder-ai/memory-plugin' },
  },
};

test('memory route only invokes a ready compatible provider and preserves the action effect boundary', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const provider = new MemoryPluginHost();
  const history = [];
  const actions = {
    exposes: async () => true,
    async attempt(instanceId, method, params) {
      history.push({ method, params });
      if (method === 'memory.describe') return { status: 'returned', value: memoryDescriptor() };
      const context = currentPluginCallContext(instanceId);
      assert.equal(context?.userId, 'owner');
      assert.equal(context?.threadId, 'default');
      return { status: 'failed', effect: 'unknown', error: new Error('provider did not report settlement') };
    },
  };
  await app.register(memoryRoutes, {
    memoryStore: createMemoryRouteProvider(provider),
    deploymentOwnerUserId: 'owner',
  });
  const write = (userId = 'owner') =>
    app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': userId },
      payload: { threadId: 'default', key: 'drink', value: 'oolong', updatedBy: 'user' },
    });

  assert.equal((await write('another-user')).statusCode, 403);
  assert.deepEqual((await write()).json(), { error: 'memory_unavailable', effect: 'not_started' });
  await provider.admit(admission, actions);
  assert.deepEqual((await write()).json(), { error: 'memory_unavailable', effect: 'not_started' });
  provider.markReady(pluginInstanceId);
  const unknown = await write();
  assert.equal(unknown.statusCode, 503);
  assert.deepEqual(unknown.json(), { error: 'memory_unavailable', effect: 'unknown' });
  provider.deactivate(pluginInstanceId);
  assert.deepEqual((await write()).json(), { error: 'memory_unavailable', effect: 'not_started' });
  assert.deepEqual(
    history.map(({ method }) => method),
    ['memory.describe', 'memory.dispatch'],
  );
});

test('memory admission probes replacements on the same installation and rejects unverified archives', async () => {
  const provider = new MemoryPluginHost();
  let offered = memoryDescriptor();
  const actions = {
    exposes: async () => true,
    attempt: async () => ({ status: 'returned', value: offered }),
  };
  await provider.admit(admission, actions);
  provider.markReady(pluginInstanceId);
  provider.deactivate(pluginInstanceId);
  offered = { ...offered, storageFormat: 2 };
  await assert.rejects(provider.admit(admission, actions), /storageFormat 2/);
  await assert.rejects(
    provider.admit(
      { ...admission, packageRecord: { ...admission.packageRecord, provenance: { kind: 'local-archive' } } },
      actions,
    ),
    /verified official package/,
  );
});

test('Matter uses the verified callback actor and validates plugin replies at the Host boundary', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const provider = new MemoryPluginHost();
  const actor = {
    userId: 'owner',
    catId: 'opus',
    threadId: 'thread',
    invocationId: 'verified-invocation',
    originTriggerMessageId: 'trigger',
    assertCurrent: async () => {},
  };
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-verified'] === 'yes') request.callbackAuth = actor;
  });
  registerCallbackMatterMemoryRoutes(app, createMatterRouteProvider(provider));
  const headers = { 'x-test-verified': 'yes', 'x-cat-cafe-user': 'spoofed-owner' };
  const catalog = () => app.inject({ url: '/api/callbacks/memory-matters?limit=2', headers });
  assert.deepEqual((await catalog()).json(), { error: 'matter_memory_unavailable', effect: 'not_started' });
  assert.match(await readMatterOpeningPrompt(provider, actor), /当前目录不可用/);

  const history = [];
  await provider.admit(admission, {
    exposes: async () => true,
    async attempt(instanceId, method, request) {
      if (method === 'memory.describe') return { status: 'returned', value: memoryDescriptor() };
      const caller = currentPluginCallContext(instanceId);
      assert.equal(caller.userId, 'owner');
      assert.equal(caller.catId, 'opus');
      assert.equal(caller.originTriggerMessageId, 'trigger');
      await caller.assertCurrent();
      history.push(request.operation);
      const value = {
        'matter.catalog': { items: [], unexpected: 'stripped' },
        'matter.read_for_invocation': { status: 'rejected', code: 'stale_revision' },
        'matter.write': { outcome: 'applied' },
        'matter.opening': 'Directory from the memory plugin',
      }[request.operation];
      return { status: 'returned', value };
    },
  });
  provider.markReady(pluginInstanceId);
  assert.deepEqual((await catalog()).json(), { items: [] });
  const stale = await app.inject({ url: '/api/callbacks/memory-matters/matter-1', headers });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'stale_revision');
  const write = await app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-matters/write',
    headers,
    payload: { operation: 'create', requestId: 'new-request', title: 'New matter', summary: 'Test data' },
  });
  assert.equal(write.statusCode, 503);
  assert.deepEqual(write.json(), { error: 'matter_memory_unavailable', effect: 'unknown' });
  assert.equal(await readMatterOpeningPrompt(provider, actor), 'Directory from the memory plugin');
  assert.deepEqual(history, ['matter.catalog', 'matter.read_for_invocation', 'matter.write', 'matter.opening']);
});

test('an action can detect replacement of the same instance while its request is in flight', async () => {
  const provider = new MemoryPluginHost();
  const actions = {
    exposes: async () => true,
    async attempt(instanceId, method) {
      if (method === 'memory.describe') return { status: 'returned', value: memoryDescriptor() };
      const original = currentPluginCallContext(instanceId);
      provider.deactivate(instanceId);
      await provider.admit(admission, actions);
      provider.markReady(instanceId);
      await assert.rejects(original.assertCurrent(), /memory_activation_changed/);
      return { status: 'failed', effect: 'unknown', error: new Error('activation changed') };
    },
  };
  await provider.admit(admission, actions);
  provider.markReady(pluginInstanceId);
  const result = await provider.attempt(
    { operation: 'kv.get', input: { threadRef: 'thread', key: 'record' } },
    { userId: 'owner', catId: 'user', threadId: 'thread', invocationId: 'call', assertCurrent: async () => {} },
  );
  assert.equal(result.effect, 'unknown');
});

test('Event routes await the admitted provider under authenticated owner scope', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-session'] === 'verified') request.sessionUserId = 'event-owner';
  });
  const provider = new MemoryPluginHost();
  await app.register(eventsRoutes, { eventMemoryStore: createEventMemoryProvider(provider) });
  const url = '/api/memory/events?limit=1&ownerUserId=spoofed';
  const headers = { 'x-test-session': 'verified' };
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.deepEqual((await app.inject({ url, headers })).json(), { error: 'memory_unavailable', effect: 'not_started' });

  await provider.admit(admission, {
    exposes: async () => true,
    async attempt(instanceId, method, request) {
      if (method === 'memory.describe') return { status: 'returned', value: memoryDescriptor() };
      assert.equal(currentPluginCallContext(instanceId)?.userId, 'event-owner');
      assert.equal(request.operation, 'event.list');
      assert.equal(request.input.limit, 2);
      assert.ok(!('ownerUserId' in request.input));
      return { status: 'returned', value: [] };
    },
  });
  provider.markReady(pluginInstanceId);
  const result = await app.inject({ url, headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { events: [], meta: { count: 0, limit: 1, offset: 0, hasMore: false } });
});

test('memory source coordinates and public reply policy are bound to the current Host call', async () => {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('owner', 'Memory source');
  const message = messageStore.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: thread.id,
    content: 'A source for memory',
    mentions: [],
    timestamp: 100,
    visibility: 'whisper',
    whisperTo: ['opus'],
    metadata: { providerModel: 'private' },
  });
  const port = createMemorySourceHost({ pluginInstanceId, messageStore, threadStore, assertActivation() {} });
  const read = (userId, memoryPublicReply = false) =>
    withPluginCallContext(
      pluginInstanceId,
      {
        userId,
        threadId: thread.id,
        catId: 'user',
        invocationId: 'call',
        assertCurrent: async () => {},
        originTriggerMessageId: message.id,
        memoryPublicReply,
      },
      async () => ({
        message: await port.readMessage(thread.id, message.id),
        trigger: await port.currentTrigger(),
      }),
    );

  await assert.rejects(port.readMessage(thread.id, message.id), /memory_source_access_denied/);
  assert.deepEqual(await read('other-owner'), { message: null, trigger: { status: 'unavailable' } });
  assert.deepEqual(await read('owner', true), { message: null, trigger: { status: 'unavailable' } });
  const source = await read('owner');
  assert.equal(source.message?.content, 'A source for memory');
  assert.equal(source.message?.metadata, undefined);
  assert.deepEqual(source.trigger, { status: 'scoped', messageId: message.id, threadId: thread.id });
});

test('background indexing receives the configured owner’s canonical thread evidence', async () => {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('custom-owner', 'Owned project');
  const game = threadStore.create('custom-owner', 'Game', 'games/example');
  const other = threadStore.create('default-user', 'Other owner');
  const seen = messageStore.append({
    from: { kind: 'user', userId: 'custom-owner' },
    userId: 'custom-owner',
    threadId: thread.id,
    content: 'Published source',
    mentions: [],
    timestamp: 100,
  });
  const source = createMemoryIndexSources({ messageStore, threadStore, ownerUserId: 'custom-owner' });
  assert.deepEqual(
    (await source.listThreads()).map(({ id }) => id),
    [thread.id],
  );
  assert.deepEqual(await source.listExcludedThreadIds(), [game.id]);
  assert.deepEqual(
    (await source.listMessages(thread.id)).map(({ id }) => id),
    [seen.id],
  );
  assert.deepEqual(await source.listMessages(other.id), []);
  assert.deepEqual(await source.listMessages(game.id), []);
});
