import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerConciergeDesktopRoutes } from '../src/routes/concierge-desktop.js';

test('only the owner reads current desktop presence or asks the existing body to show; no installation or voice starts', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let calls = 0,
    shows = 0,
    expiresAt = 3000;
  let desktopLost = false;
  let lossId = 'loss-A';
  let readFails = false;
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  registerConciergeDesktopRoutes(app, {
    ownerUserId: 'default-user',
    now: () => 1000,
    desktop: {
      presence: async () => {
        calls++;
        if (readFails) throw new Error('owner inventory unavailable');
        return {
          state: 'visible',
          observedAt: 900,
          expiresAt,
          pluginInstanceId: 'private-instance',
          contributionId: 'body',
        };
      },
      show: async () => {
        shows++;
      },
      hasUnexpectedLoss: async () => desktopLost,
      unexpectedLossId: async () => (desktopLost ? lossId : null),
    },
  });
  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/concierge/desktop',
    headers: { 'x-cat-cafe-user': 'default-user' },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(calls, 0);
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:3011' };
  const visible = await app.inject({ method: 'GET', url: '/api/concierge/desktop', headers });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json(), { presence: { state: 'visible', maxAgeMs: 2000 } });
  const injected = await app.inject({
    method: 'POST',
    url: '/api/concierge/desktop/show',
    headers,
    payload: { pluginInstanceId: 'other' },
  });
  assert.equal(injected.statusCode, 400);
  assert.equal(shows, 0);
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/concierge/desktop/show',
    headers: { ...headers, origin: 'https://foreign.invalid' },
    payload: {},
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(shows, 0);
  const shown = await app.inject({ method: 'POST', url: '/api/concierge/desktop/show', headers, payload: {} });
  assert.equal(shown.statusCode, 200);
  assert.equal(shows, 1);
  expiresAt = 999;
  const stale = await app.inject({ method: 'GET', url: '/api/concierge/desktop', headers });
  assert.deepEqual(stale.json(), { presence: null, desktopLost: false });
  desktopLost = true;
  const lost = await app.inject({ method: 'GET', url: '/api/concierge/desktop', headers });
  assert.deepEqual(lost.json(), { presence: null, desktopLost: true, lossId: 'loss-A' });
  lossId = 'loss-B';
  const newLoss = await app.inject({ method: 'GET', url: '/api/concierge/desktop', headers });
  assert.deepEqual(newLoss.json(), { presence: null, desktopLost: true, lossId: 'loss-B' });
  readFails = true;
  const unavailable = await app.inject({ method: 'GET', url: '/api/concierge/desktop', headers });
  assert.equal(unavailable.statusCode, 503, 'an unreadable Host cannot report that the desktop recovered');
});
