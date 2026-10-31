import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { audioProxyRoutes } from '../src/routes/audio-proxy.js';

test('guarded controller stop cannot stop a different capture; correct binding keeps lease private', async (t) => {
  const saved = globalThis.fetch;
  const app = Fastify();
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    return new Response(
      JSON.stringify(
        path === '/start'
          ? {
              lease_token: 'private-token',
              status: {
                thread_id: 'capture-thread',
                meeting_id: 'meeting-1',
                started_at: 100,
              },
            }
          : { ok: true, status: { running: false, lifecycle_state: 'stopped', controller_lease: null } },
      ),
    );
  };
  t.after(async () => {
    await app.close();
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes);
  const headers = { 'x-cat-cafe-user': 'owner' };
  await app.inject({ method: 'POST', url: '/api/audio/start', headers, payload: { thread_id: 'capture-thread' } });
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/audio/stop',
    headers,
    payload: {
      expected_capture: { thread_id: 'capture-thread', meeting_id: 'meeting-other', started_at: 100 },
    },
  });
  assert.equal(wrong.statusCode, 409);
  assert.equal(calls.includes('/stop'), false);
  const correct = await app.inject({
    method: 'POST',
    url: '/api/audio/stop',
    headers,
    payload: {
      expected_capture: { thread_id: 'capture-thread', meeting_id: 'meeting-1', started_at: 100 },
    },
  });
  assert.equal(correct.statusCode, 200);
  assert.doesNotMatch(correct.payload, /private-token/);
});

test('only one concurrent start reaches the sidecar while lease creation is pending', async (t) => {
  const saved = globalThis.fetch;
  const app = Fastify();
  let release!: () => void;
  let firstEntered!: () => void;
  let secondEntered!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const secondSeen = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/start')) {
      starts++;
      if (starts === 1) firstEntered();
      else secondEntered();
      await wait;
      return new Response(JSON.stringify({ lease_token: 'one-lease' }));
    }
    return new Response('{}');
  };
  t.after(async () => {
    release();
    await app.close();
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes);
  const command = {
    method: 'POST' as const,
    url: '/api/audio/start',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { thread_id: 'capture-thread' },
  };
  const first = app.inject(command);
  await firstSeen;
  const second = app.inject(command);
  await Promise.race([second.then(() => undefined), secondSeen]);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
});

test('failed or unknown status cannot release an owned controller lease', async (t) => {
  const saved = globalThis.fetch;
  const app = Fastify();
  let statusCode = 503;
  let statusBody: unknown = { running: false };
  let starts = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/start') {
      starts++;
      return Response.json({ lease_token: 'owned-private-token' });
    }
    if (path === '/status') return Response.json(statusBody, { status: statusCode });
    return Response.json({ ok: true, status: { running: false, lifecycle_state: 'stopped', controller_lease: null } });
  };
  t.after(async () => {
    await app.close();
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes);
  const command = {
    method: 'POST' as const,
    url: '/api/audio/start',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { thread_id: 'capture-thread' },
  };
  assert.equal((await app.inject(command)).statusCode, 200);
  const status = { method: 'GET' as const, url: '/api/audio/status', headers: command.headers };
  assert.equal((await app.inject(status)).statusCode, 503);
  assert.equal((await app.inject(command)).statusCode, 409);
  statusCode = 200;
  statusBody = { running: null };
  assert.equal((await app.inject(status)).statusCode, 200);
  assert.equal((await app.inject(command)).statusCode, 409);
  assert.equal(starts, 1);
});

test('late stopped status for a released lease cannot clear the next capture lease', async (t) => {
  const saved = globalThis.fetch;
  const app = Fastify();
  let releaseStatus!: (response: Response) => void;
  let statusEntered!: () => void;
  const statusSeen = new Promise<void>((resolve) => {
    statusEntered = resolve;
  });
  const pendingStatus = new Promise<Response>((resolve) => {
    releaseStatus = resolve;
  });
  let starts = 0;
  const stoppedTokens: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/start') {
      starts++;
      return Response.json({
        lease_token: `private-${starts}`,
        status: { thread_id: body.thread_id, meeting_id: `meeting-${starts}`, started_at: starts },
      });
    }
    if (path === '/status') {
      statusEntered();
      return pendingStatus;
    }
    if (path === '/stop') stoppedTokens.push(body.lease_token);
    return Response.json({ ok: true, status: { running: false, lifecycle_state: 'stopped', controller_lease: null } });
  };
  t.after(async () => {
    releaseStatus(Response.json({ running: false, lifecycle_state: 'stopped', controller_lease: null }));
    await app.close();
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes);
  const headers = { 'x-cat-cafe-user': 'owner' };
  const start = (thread: string) =>
    app.inject({
      method: 'POST',
      url: '/api/audio/start',
      headers,
      payload: { thread_id: thread },
    });
  assert.equal((await start('old-thread')).statusCode, 200);
  const oldStatus = app.inject({ method: 'GET', url: '/api/audio/status', headers });
  await statusSeen;
  assert.equal((await app.inject({ method: 'POST', url: '/api/audio/stop', headers, payload: {} })).statusCode, 200);
  assert.equal((await start('new-thread')).statusCode, 200);
  releaseStatus(Response.json({ running: false, lifecycle_state: 'stopped', controller_lease: null }));
  assert.equal((await oldStatus).statusCode, 200);
  assert.equal((await start('unrelated-thread')).statusCode, 409);
  const stop = await app.inject({
    method: 'POST',
    url: '/api/audio/stop',
    headers,
    payload: { expected_capture: { thread_id: 'new-thread', meeting_id: 'meeting-2', started_at: 2 } },
  });
  assert.equal(stop.statusCode, 200, stop.payload);
  assert.deepEqual(stoppedTokens, ['private-1', 'private-2']);
  assert.equal(starts, 2);
});
