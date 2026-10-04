import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerLiveTranscriptRoutes } from '../src/routes/concierge-live-transcript.js';

test('owner captions read durable sources after call retirement; no foreign scope or selector crosses the route', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'caption-owner';
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'caption-owner' });
  const store = new MessageStore();
  const callId = randomUUID();
  const owner = 'caption-owner';
  const saved = await persistLiveUserText(
    store,
    { userId: owner, threadId: 'home', callId },
    'durable typing',
    randomUUID(),
  );
  await persistLiveUserText(store, { userId: 'foreign', threadId: 'home', callId }, 'secret', randomUUID());
  let current = true;
  registerLiveTranscriptRoutes(app, {
    ownerUserId: owner,
    messages: store,
    sessions: { get: () => undefined },
    threads: { getOrCreate: async () => 'home', isCurrent: async () => current },
  });
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(session.headers['set-cookie']).split(';')[0] };
  try {
    const result = await app.inject({ url: `/api/concierge/live/${callId}/transcript`, headers });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      result.json().messages.map((row: { id: string }) => row.id),
      [saved.message.id],
    );
    assert.equal(result.json().hasMore, false);
    assert.equal((await app.inject({ url: `/api/concierge/live/${callId}/transcript` })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: `/api/concierge/live/${callId}/transcript?threadId=foreign`, headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `/api/concierge/live/${callId}/transcript`, headers, remoteAddress: '192.0.2.1' }))
        .statusCode,
      403,
    );
    current = false;
    assert.equal((await app.inject({ url: `/api/concierge/live/${callId}/transcript`, headers })).statusCode, 409);
  } finally {
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  }
});
