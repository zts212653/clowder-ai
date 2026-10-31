import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { audioProxyRoutes } from '../src/routes/audio-proxy.js';
import { createF317MeetingAudioPort } from '../src/routes/f317-meeting-audio-port.js';

const headers = { 'x-cat-cafe-user': 'owner' };
const target = { thread_id: 'thread-1', meeting_id: 'meeting-1', started_at: 100 };

test('caller timeout drains the accepted start and retains its private lease for exact cleanup', async (t) => {
  const saved = globalThis.fetch,
    app = Fastify();
  let release!: (response: Response) => void, entered!: () => void;
  const seen = new Promise<void>((r) => {
    entered = r;
  });
  const pending = new Promise<Response>((r) => {
    release = r;
  });
  let signal: AbortSignal | null | undefined;
  let running = false;
  const stoppedTokens: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/start') {
      signal = init?.signal;
      entered();
      return pending;
    }
    if (path === '/stop') {
      stoppedTokens.push(JSON.parse(String(init?.body)).lease_token);
      running = false;
    }
    const status = {
      ...target,
      running,
      paused: false,
      inputs: [],
      chunk_count: 0,
      lifecycle_state: running ? 'running' : 'stopped',
      controller_lease: running ? { expired: false } : null,
    };
    return Response.json(path === '/stop' ? { ok: true, status } : status);
  };
  t.after(async () => {
    release(Response.json({ error: 'test cleanup' }, { status: 400 }));
    await app.close();
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes, { requestTimeoutMs: 500 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const audio = createF317MeetingAudioPort(app, 'owner', { requestTimeoutMs: 20 });
  const opening = audio.start({
    threadId: target.thread_id,
    meetingId: target.meeting_id,
    source: { id: 'Chrome', name: 'Chrome' },
  });
  opening.catch(() => undefined);
  await seen;
  t.mock.timers.tick(21);
  await assert.rejects(opening, /504.*deadline/);
  assert.equal(signal?.aborted, false, 'the caller leaving is not remote cancellation');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/audio/start', headers, payload: { thread_id: 'next' } })).statusCode,
    409,
  );
  running = true;
  release(Response.json({ lease_token: 'private-late-token', status: { ...target, running } }));
  await new Promise<void>((r) => setImmediate(r));
  const stopped = await app.inject({
    method: 'POST',
    url: '/api/audio/stop',
    headers,
    payload: { expected_capture: target },
  });
  assert.equal(stopped.statusCode, 200, stopped.payload);
  assert.deepEqual(stoppedTokens, ['private-late-token']);
  assert.doesNotMatch(stopped.payload, /private-late-token/);
});

test('expired Host TTL cannot release a sidecar finalizer, but finalized observation permits recovery', async (t) => {
  const saved = globalThis.fetch,
    savedNow = Date.now,
    app = Fastify();
  let now = savedNow(),
    finalizing = true,
    starts = 0;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/start') return Response.json({ lease_token: `private-${++starts}`, status: target });
    const status = {
      running: false,
      lifecycle_state: finalizing ? 'finalizing' : 'stopped',
      controller_lease: finalizing ? { expired: true } : null,
    };
    return Response.json(path === '/stop' ? { ok: true, status } : status);
  };
  t.after(async () => {
    finalizing = false;
    await app.close();
    Date.now = savedNow;
    globalThis.fetch = saved;
  });
  await app.register(audioProxyRoutes);
  const start = () =>
    app.inject({ method: 'POST', url: '/api/audio/start', headers, payload: { thread_id: 'thread-1' } });
  assert.equal((await start()).statusCode, 200);
  now += 20_000;
  assert.equal((await start()).statusCode, 409);
  assert.equal(starts, 1);
  finalizing = false;
  assert.equal((await start()).statusCode, 200);
  assert.equal(starts, 2);
});

test('legacy start/stop deadlines cover the pre-existing sixty-second service contract', async (t) => {
  const saved = globalThis.fetch,
    app = Fastify();
  let release!: (response: Response) => void, entered!: () => void;
  const pending = new Promise<Response>((r) => {
    release = r;
  });
  const seen = new Promise<void>((r) => {
    entered = r;
  });
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/start')) {
      signal = init?.signal;
      entered();
      return pending;
    }
    return Response.json({ ok: true, status: { running: false, lifecycle_state: 'stopped', controller_lease: null } });
  };
  await app.register(audioProxyRoutes);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => {
    t.mock.timers.reset();
    release(Response.json({ error: 'cleanup' }, { status: 400 }));
    await app.close();
    globalThis.fetch = saved;
  });
  const opening = app.inject({ method: 'POST', url: '/api/audio/start', headers, payload: { thread_id: 'thread-1' } });
  await seen;
  t.mock.timers.tick(65_001);
  assert.equal(signal?.aborted, false, 'a legitimate cold sixty-second health probe is within budget');
  release(Response.json({ lease_token: 'private', status: target }));
  assert.equal((await opening).statusCode, 200);
});
