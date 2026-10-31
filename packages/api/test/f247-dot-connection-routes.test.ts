import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { registerDotConnectionRoutes } from '../src/routes/chatgpt-dot-connection-routes.js';
import { registerDotTestRoutes } from '../src/routes/chatgpt-dot-test-routes.js';

test('connection state and setup require the actual owner; user fields cannot manufacture credentials', async () => {
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner';
  const directory = await mkdtemp(join(tmpdir(), 'f247-dot-route-'));
  const keys = new AgentKeyRegistry();
  const store = new DotConnectionStore(join(directory, 'connection.json'));
  const service = new DotConnectionService({
    store,
    keys,
    ensureIdentity: async () => {},
    authority: async () => ({ ownerUserId: owner, pluginInstanceId: 'pi_dot' }),
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (typeof request.headers['x-test-session-user'] === 'string')
      request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerDotConnectionRoutes(app, { connection: service, publicBaseUrl: () => 'https://example.com' });
  registerDotTestRoutes(app, {
    connection: service,
    dispatches: new DotDispatchStore(join(directory, 'events')),
    threads: new ThreadStore(),
    startTest: async () => {
      throw new Error('unexpected test start');
    },
  });
  const headers = { host: 'localhost:3102', origin: 'http://localhost:3101', 'x-test-session-user': owner };
  try {
    assert.equal((await app.inject({ url: '/api/plugins/chatgpt-dot/connection' })).statusCode, 401);
    const guest = await app.inject({
      url: '/api/plugins/chatgpt-dot/connection',
      headers: { ...headers, 'x-test-session-user': 'guest' },
    });
    assert.equal(guest.statusCode, 403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/plugins/chatgpt-dot/prepare',
      headers,
      payload: { catId: 'gpt-pro', ownerUserId: 'guest' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(await store.read(), null);
    const setup = await app.inject({ method: 'POST', url: '/api/plugins/chatgpt-dot/prepare', headers, payload: {} });
    assert.equal(setup.statusCode, 200, setup.payload);
    assert.equal(new URL(setup.json().endpointUrl).search, '', 'prepare never exports a second connection credential');
    assert.equal(setup.json().credentialSecret, undefined);
    assert.equal(setup.json().catId, 'gpt-dot');
    assert.equal(new URL(setup.json().endpointUrl).pathname, '/mcp');
    const status = await app.inject({ url: '/api/plugins/chatgpt-dot/connection', headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().paired, false);
    assert.equal(status.json().credentialSecret, undefined);
    assert.equal(Object.hasOwn(status.json(), 'allowedCatIds'), false);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(new URL(status.json().endpointUrl).search, '', 'read projection never leaks a credential-bearing URL');
    const before = await store.read();
    const retired = await app.inject({
      method: 'POST',
      url: '/api/plugins/chatgpt-dot/allowed-cats',
      headers,
      payload: { catIds: [] },
    });
    assert.equal(retired.statusCode, 404, 'retired settings cannot reinstate a per-cat restriction');
    assert.deepEqual(await store.read(), before);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
