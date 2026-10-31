import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { OwnerPageActionService } from '../src/domains/concierge/live/host/owner-page-action-service.ts';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.ts';
import { f317PageActionRoutes } from '../src/routes/f317-page-action.ts';

test('owner page entry is private, strict, and unavailable without a named Host page', async (t) => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  const service = new OwnerPageActionService({
    ownerUserId: 'default-user',
    sessions: {
      async observeCall() {
        return null;
      },
    },
    messages: {
      async getByThread() {
        return [];
      },
    },
  });
  await app.register(f317PageActionRoutes, { ownerUserId: 'default-user', service });
  t.after(() => app.close());

  const route = '/api/concierge/page-action';
  assert.equal((await app.inject({ method: 'GET', url: route })).statusCode, 401);
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:3011' };
  const status = await app.inject({ method: 'GET', url: route, headers });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), { kind: 'unavailable' });
  assert.equal((await app.inject({ method: 'GET', url: route, headers, remoteAddress: '192.0.2.10' })).statusCode, 403);
  const forged = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: 'source', url: 'http://127.0.0.1:5227/', selector: '#delete-note' },
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(
    (await app.inject({ method: 'POST', url: `${route}/inspect`, headers, payload: { requestMessageId: 'source' } }))
      .statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: `${route}/confirm`, headers, payload: { previewId: 'not-a-uuid' } }))
      .statusCode,
    400,
  );
});
