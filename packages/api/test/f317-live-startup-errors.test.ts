import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, createCatId } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeLiveRoutes } from '../src/routes/concierge-live.js';

async function fixture(dutyCatProfileId = 'codex') {
  const app = Fastify();
  const sessions = new LiveCompanionSessions();
  const messageStore = new MessageStore();
  const configStore = { get: async () => ({ ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId }) };
  let threadReads = 0;
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(conciergeLiveRoutes, {
    ownerUserId: 'default-user',
    configStore,
    sessions,
    threadService: {
      getOrCreate: async () => {
        threadReads += 1;
        return 'home';
      },
    },
    messageStore,
    sessionChainStore: { getActive: async () => null },
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    publish() {},
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const rawCookie = login.headers['set-cookie'];
  assert.ok(typeof rawCookie === 'string');
  const sessionCookie = rawCookie.split(';')[0];
  assert.ok(sessionCookie);
  const headers = { cookie: sessionCookie, origin: 'http://localhost:3011' };
  return {
    app,
    sessions,
    messageStore,
    configStore,
    threadReads: () => threadReads,
    request: () =>
      app.inject({
        method: 'POST',
        url: '/api/concierge/live',
        headers,
        payload: { allowHomeReads: true },
      }),
  };
}

test('an initialization failure is not reported as an active conversation or leaked to the surface', async (t) => {
  const { app, sessions, request } = await fixture();
  t.after(() => app.close());
  t.mock.method(sessions, 'prepare', async () => {
    throw new Error('credential file failed: /private/home/owner/secret');
  });
  const response = await request();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'live_prepare_failed');
  assert.doesNotMatch(response.body, /active|credential|private|secret/);
});

test('configuration read failures remain distinct from missing cats and never echo storage details', async (t) => {
  const { app, configStore, request, threadReads } = await fixture();
  t.after(() => app.close());
  t.mock.method(configStore, 'get', async () => {
    throw new Error('private storage credential failed');
  });
  const response = await request();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'live_configuration_unavailable');
  assert.doesNotMatch(response.body, /private|credential/);
  assert.equal(threadReads(), 0);
});

test('only a real occupied owner slot reports the retryable active-call conflict', async (t) => {
  const { app, sessions, messageStore, request } = await fixture();
  t.after(() => app.close());
  const call = await sessions.prepare({
    binding: { userId: 'default-user', threadId: 'home', catId: createCatId('codex'), callId: 'occupied' },
    messageStore,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  const response = await request();
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'live_call_active');
  assert.equal(sessions.get(call.id, 'default-user'), call);
  assert.equal(call.status().state, 'preparing', 'a rejected second call does not disturb the existing call');
});

test('a missing selected identity is rejected before allocating a companion thread', async (t) => {
  const { app, request, threadReads } = await fixture('missing-selected-cat');
  t.after(() => app.close());
  const response = await request();
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'live_duty_unavailable');
  assert.equal(threadReads(), 0);
});
