import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerPersonalChromePluginRoutes } from '../dist/routes/personal-chrome-plugin-routes.js';

test('only an explicit local-owner POST refreshes names; state reads and rejected callers cannot trigger it', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  const owner = 'owner-user';
  process.env.DEFAULT_OWNER_USER_ID = owner;
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const state = { titleSync: { status: 'synced', updatedCount: 1, requestedCount: 2 } };
  let refreshes = 0;
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-user'];
  });
  registerPersonalChromePluginRoutes(app, {
    port: {
      inspect: async () => state,
      refreshTitles: async () => {
        refreshes++;
        return state;
      },
    },
  });
  const headers = { host: 'localhost:3004', origin: 'http://localhost:5173', 'x-test-user': owner };
  for (const changedHeaders of [
    { 'x-test-user': '' },
    { 'x-test-user': 'foreign' },
    { origin: 'https://evil.example' },
    { host: 'remote.example' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/personal-chrome/refresh-titles',
      headers: { ...headers, ...changedHeaders },
    });
    assert.ok(
      [401, 403].includes(response.statusCode),
      `untrusted refresh must fail owner access, got ${response.statusCode}`,
    );
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/personal-chrome', headers })).statusCode, 200);
  assert.equal(refreshes, 0);
  const response = await app.inject({ method: 'POST', url: '/api/plugins/personal-chrome/refresh-titles', headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), state);
  assert.equal(refreshes, 1);
});
