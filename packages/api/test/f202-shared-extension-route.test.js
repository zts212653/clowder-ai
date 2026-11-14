import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { PluginSharedExtensionError } from '../dist/domains/plugin/shared-extension/plugin-shared-extension.js';
import { pluginSharedExtensionRoutes } from '../dist/routes/plugin/plugin-shared-extension-routes.js';

test('shared extension route accepts only the server-bound AgentKey shape', async () => {
  const calls = [];
  const app = Fastify();
  await app.register(pluginSharedExtensionRoutes, {
    service: {
      handle: async (secret, rpc) => {
        calls.push({ secret, rpc });
        return { jsonrpc: '2.0', id: rpc.id, result: { tools: [] } };
      },
    },
  });

  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/shared/handle',
    headers: { 'x-agent-key-secret': 'bound-key' },
    payload: body,
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { jsonrpc: '2.0', id: 1, result: { tools: [] } });
  assert.deepEqual(calls, [{ secret: 'bound-key', rpc: body }]);

  for (const headers of [
    {},
    { 'x-agent-key-secret': 'bound-key', authorization: 'Bearer forged' },
    { 'x-agent-key-secret': 'bound-key', 'x-invocation-id': 'forged' },
    { 'x-agent-key-secret': 'bound-key', 'x-callback-token': 'forged' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/shared/handle',
      headers,
      payload: body,
    });
    assert.equal(response.statusCode, Object.keys(headers).length === 0 ? 401 : 403);
  }
  assert.equal(calls.length, 1, 'rejected caller identity never reaches the shared service');
  await app.close();
});

test('changed legacy tool authorization has an executable migration instruction', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(pluginSharedExtensionRoutes, {
    service: {
      handle: async () => {
        throw new PluginSharedExtensionError(409, 'shared_surface_changed');
      },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/shared/handle',
    headers: { 'x-agent-key-secret': 'bound-key' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'shared_surface_changed');
  assert.match(response.json().message, /Restore.*enable.*Server URL.*ChatGPT.*subscription/);
});
