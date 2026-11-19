import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDescriptor } from '@clowder-ai/plugin-memory-contract';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { MemoryPluginHost } from '../dist/domains/plugin/host-surface/memory-plugin-host.js';
import { createMemorySourceHost } from '../dist/domains/plugin/host-surface/memory-source-host.js';
import { memoryRoutes } from '../dist/routes/memory.js';
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
