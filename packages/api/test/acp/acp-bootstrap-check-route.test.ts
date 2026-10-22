import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAgentClientLibraryRoutes } from '../../src/routes/agent-client-library-routes.ts';

test('directory inspection requires a local owner, validates input and never consults plugins or launches a client', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'bootstrap-owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = String(request.headers['x-test-user'] ?? '') || undefined;
  });
  registerAgentClientLibraryRoutes(app, {
    inventory: { snapshot: () => assert.fail('must not read plugin inventory') },
    packages: {},
    configuration: {},
    registry: {},
  } as unknown as Parameters<typeof registerAgentClientLibraryRoutes>[1]);
  t.after(() => app.close());
  const url = '/api/agent-providers/bootstrap-check';
  const headers = { host: 'localhost:4312', origin: 'http://localhost:4311', 'x-test-user': 'bootstrap-owner' };
  assert.equal(
    (await app.inject({ method: 'POST', url, headers: { host: headers.host, origin: headers.origin }, payload: {} }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url, headers: { ...headers, 'x-test-user': 'other' }, payload: {} }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url, headers: { ...headers, host: '192.168.1.20' }, payload: {} })).statusCode,
    403,
  );
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { root: '../relative' } })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: 'POST', url, headers, payload: { root: '', allowVolumeRootDelete: true } })).statusCode,
    400,
  );
});
