import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify from 'fastify';

const { sessionAuthPlugin, sessionRoute } = await import('../dist/infrastructure/session-auth.js');
const { cacheRetentionProbeRoutes } = await import('../dist/routes/cache-retention-probe.js');

async function fixture(t, { enabled = true, createdBy = 'owner' } = {}) {
  const calls = [];
  const preferences = new Map();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookiePlugin);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  await app.register(cacheRetentionProbeRoutes, {
    enabled,
    threads: { get: async () => ({ id: 'thread', createdBy }) },
    service: {
      probe: async (input) => {
        input.assertCurrent();
        calls.push(input);
        return { outcome: 'sample_pass' };
      },
    },
    settings: {
      get: async (userId, catId) => ({
        catId,
        supported: true,
        enabled: preferences.get(`${userId}:${catId}`) ?? false,
        sessions: [],
      }),
      set: async (userId, catId, value) => {
        preferences.set(`${userId}:${catId}`, value);
        return { catId, supported: true, enabled: value, sessions: [] };
      },
    },
  });
  const session = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1' });
  const csrf = session.json().csrfToken;
  const cookie = session.headers['set-cookie'].split(';', 1)[0];
  const post = (headers = {}, payload = {}) =>
    app.inject({
      method: 'POST',
      remoteAddress: '127.0.0.1',
      url: '/api/threads/thread/sessions/sonnet/cache-retention-probe',
      headers,
      payload,
    });
  return { app, calls, post, headers: { cookie, 'x-csrf-token': csrf } };
}

test('F338: probe is unavailable on runtime and never calls the provider', async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.post(f.headers)).statusCode, 404);
  assert.equal(f.calls.length, 0);
});
test('F338: only an issued local owner session with CSRF and thread access can enter', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ 'x-cat-cafe-user': 'owner' })).statusCode, 401);
  assert.equal((await f.post({ cookie: f.headers.cookie })).statusCode, 403);
  assert.equal(
    (await f.post(f.headers, { sessionId: 'caller-chosen', callbackToken: 'caller-chosen' })).statusCode,
    400,
  );
  const accepted = await f.post(f.headers);
  assert.equal(accepted.statusCode, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].userId, 'owner');
  assert.equal(f.calls[0].catId, 'sonnet');
});
test('F338: a local owner cannot probe a foreign thread', async (t) => {
  const f = await fixture(t, { createdBy: 'someone-else' });
  assert.equal((await f.post(f.headers)).statusCode, 403);
  assert.equal(f.calls.length, 0);
});

test('F338: product preference is off until the owner enables it and survives another read', async (t) => {
  const f = await fixture(t, { enabled: false });
  const request = (method, cat = 'sonnet', payload) =>
    f.app.inject({
      method,
      url: `/api/cats/${cat}/cache-retention`,
      remoteAddress: '127.0.0.1',
      headers: f.headers,
      ...(payload ? { payload } : {}),
    });
  const initial = await request('GET');
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().enabled, false);
  assert.equal((await request('PUT', 'sonnet', { enabled: true })).json().enabled, true);
  assert.equal((await request('GET')).json().enabled, true);
  assert.equal((await request('GET', 'opus')).json().enabled, false);
  assert.equal((await request('PUT', 'sonnet', { enabled: false })).json().enabled, false);
  assert.equal(f.calls.length, 0, 'A preference change never invokes a provider');
});

test('F338: only a current owner with CSRF can opt in, and callers cannot extend the bound', async (t) => {
  const f = await fixture(t);
  const put = (headers, payload = { enabled: true }) =>
    f.app.inject({
      method: 'PUT',
      url: '/api/cats/sonnet/cache-retention',
      remoteAddress: '127.0.0.1',
      headers,
      payload,
    });
  assert.equal((await put({ 'x-cat-cafe-user': 'owner' })).statusCode, 401);
  assert.equal((await put({ cookie: f.headers.cookie })).statusCode, 403);
  assert.equal((await put(f.headers, { enabled: true, maxDurationMs: 999999999 })).statusCode, 400);
  assert.equal((await put(f.headers, { enabled: 'yes' })).statusCode, 400);
  assert.equal(f.calls.length, 0);
});
