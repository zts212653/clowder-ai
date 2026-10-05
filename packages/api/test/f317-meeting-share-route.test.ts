import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { f317MeetingShareRoutes } from '../src/routes/f317-meeting-share.js';

test('only direct-local owner click grants exact meeting to exact call; stale stop revokes', async (t) => {
  const app = Fastify();
  const threads = new ThreadStore();
  const meetingThread = await threads.create('default-user');
  const capture = {
    running: true,
    paused: false,
    thread_id: meetingThread.id,
    meeting_id: 'mtg-1',
    started_at: 100,
    inputs: [{ id: 'app-1', source: 'app', label: 'Local test app', state: 'running' }],
  };
  const attached: string[] = [];
  let liveGrantId: string | null = null;
  let verify: (() => Promise<boolean>) | undefined;
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(f317MeetingShareRoutes, {
    ownerUserId: 'default-user',
    threadStore: threads,
    host: {
      observeCall: async (userId) => ({
        userId,
        threadId: 'live-thread',
        catId: 'codex6-sol',
        callId: 'call-1',
        generation: 1,
        state: 'talking',
      }),
      attach: async (grant, check) => {
        attached.push(grant.grantId);
        liveGrantId = grant.grantId;
        verify = check;
      },
      detach: async (grant) => {
        if (liveGrantId === grant.grantId) liveGrantId = null;
      },
      isAttached: (grant) => liveGrantId === grant.grantId,
    },
    audioServiceUrl: 'http://127.0.0.1:9881',
    fetchFn: async () => new Response(JSON.stringify(capture), { status: 200 }),
  });
  t.after(() => app.close());
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers: { origin: 'http://localhost:3011', 'x-cat-cafe-user': 'default-user' },
    payload: { callId: 'call-1' },
  });
  assert.equal(anonymous.statusCode, 401);
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const rawCookie = login.headers['set-cookie'];
  assert.equal(typeof rawCookie, 'string');
  const headers = { cookie: (rawCookie as string).split(';')[0], origin: 'http://localhost:3011' };
  const remote = await app.inject({
    method: 'GET',
    url: '/api/concierge/meeting-share',
    headers,
    remoteAddress: '192.0.2.10',
  });
  assert.equal(remote.statusCode, 403);
  const preview = await app.inject({ method: 'GET', url: '/api/concierge/meeting-share', headers });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().kind, 'available');
  assert.equal(preview.json().sharing, false);
  assert.equal(attached.length, 0);
  const forged = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: { ...preview.json().intent, actorUserId: 'other-user' },
  });
  assert.equal(forged.statusCode, 400);
  capture.inputs[0] = { id: 'app-2', source: 'app', label: 'Different App', state: 'running' };
  const changedApp = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: preview.json().intent,
  });
  assert.equal(changedApp.statusCode, 409);
  assert.equal(attached.length, 0);
  capture.inputs[0] = { id: 'app-1', source: 'app', label: 'Renamed App', state: 'running' };
  const changedLabel = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: preview.json().intent,
  });
  assert.equal(changedLabel.statusCode, 409);
  assert.equal(attached.length, 0);
  capture.inputs[0] = { id: 'app-1', source: 'app', label: 'Local test app', state: 'running' };
  const shared = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: preview.json().intent,
  });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.json().sharing, true);
  assert.equal(attached.length, 1);
  assert.equal(await verify?.(), true);
  liveGrantId = null;
  const stalePost = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: preview.json().intent,
  });
  assert.equal(stalePost.statusCode, 409);
  assert.equal(attached.length, 1);
  const lost = await app.inject({ method: 'GET', url: '/api/concierge/meeting-share', headers });
  assert.equal(lost.statusCode, 200);
  assert.equal(lost.json().kind, 'available');
  assert.equal(lost.json().sharing, false);
  assert.equal(await verify?.(), false);
  const freshPost = await app.inject({
    method: 'POST',
    url: '/api/concierge/meeting-share',
    headers,
    payload: preview.json().intent,
  });
  assert.equal(freshPost.statusCode, 200, 'a new explicit click may grant a fresh attachment');
  assert.equal(attached.length, 2);
  capture.running = false;
  assert.equal(await verify?.(), false);
  const late = await app.inject({ method: 'GET', url: '/api/concierge/meeting-share', headers });
  assert.equal(late.json().kind, 'unavailable');
});
