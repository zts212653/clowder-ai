import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDescriptor } from '@clowder-ai/plugin-memory-contract';
import Fastify from 'fastify';
import { currentPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { MemoryPluginHost } from '../dist/domains/plugin/host-surface/memory-plugin-host.js';
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
