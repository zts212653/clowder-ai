import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { audioProxyRoutes } from '../src/routes/audio-proxy.js';
import { createF317MeetingAudioPort } from '../src/routes/f317-meeting-audio-port.js';

test('timed-out legacy start retains its unconfirmed reservation instead of starting another capture', async (t) => {
  const original = globalThis.fetch;
  const app = Fastify();
  let starts = 0,
    aborted = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/start'))
      return Response.json({ running: false, paused: false, inputs: [], chunk_count: 0 });
    starts++;
    return await new Promise<Response>((_resolve, reject) => {
      const cleanup = setTimeout(() => reject(new Error('test releases unbounded request')), 200);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(cleanup);
          aborted++;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  };
  t.after(async () => {
    await app.close();
    globalThis.fetch = original;
  });
  await app.register(audioProxyRoutes, { requestTimeoutMs: 20 });
  const audio = createF317MeetingAudioPort(app, 'owner');
  await assert.rejects(
    audio.start({ threadId: 'thread-1', meetingId: 'meeting-1', source: { id: 'Chrome', name: 'Chrome' } }),
    /504.*deadline/i,
  );
  await assert.rejects(
    audio.start({ threadId: 'thread-1', meetingId: 'meeting-2', source: { id: 'Chrome', name: 'Chrome' } }),
    /409/i,
  );
  assert.equal(starts, 1);
  assert.equal(aborted, 1);
});

test('internal injection cancellation reaches the sidecar, independently of its longer server deadline', async (t) => {
  const original = globalThis.fetch;
  const app = Fastify();
  let aborted = false;
  globalThis.fetch = async (_url, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const cleanup = setTimeout(() => reject(new Error('test releases pending connection')), 200);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(cleanup);
          aborted = true;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  t.after(async () => {
    await app.close();
    globalThis.fetch = original;
  });
  await app.register(audioProxyRoutes, { requestTimeoutMs: 500 });
  const audio = createF317MeetingAudioPort(app, 'owner', { requestTimeoutMs: 20 });
  await assert.rejects(audio.sources(), /504.*deadline/i);
  assert.equal(aborted, true, 'aborting app.inject must also abort its upstream fetch');
});

test('controller deadline also bounds stalled body decoding after sidecar response headers', async (t) => {
  const original = globalThis.fetch;
  const app = Fastify();
  let aborted = false;
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const cleanup = setTimeout(() => controller.error(new Error('test releases stalled body')), 200);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(cleanup);
              aborted = true;
              controller.error(init.signal?.reason);
            },
            { once: true },
          );
        },
      }),
    );
  t.after(async () => {
    await app.close();
    globalThis.fetch = original;
  });
  await app.register(audioProxyRoutes, { requestTimeoutMs: 20 });
  const audio = createF317MeetingAudioPort(app, 'owner');
  await assert.rejects(audio.sources(), /504.*deadline/i);
  assert.equal(aborted, true);
});

test('bounded source/status/stop reads preserve an exact lease when stop remains unconfirmed', async (t) => {
  const original = globalThis.fetch;
  const app = Fastify();
  const aborted: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/start')
      return Response.json({
        lease_token: 'private',
        status: {
          thread_id: 'thread-1',
          meeting_id: 'meeting-1',
          started_at: 100,
          running: true,
          paused: false,
          chunk_count: 0,
          inputs: [{ id: 'primary', source: 'app', label: 'Chrome', app_name: 'Chrome', state: 'running' }],
        },
      });
    return await new Promise<Response>((_resolve, reject) => {
      const cleanup = setTimeout(() => reject(new Error('test releases unbounded request')), 200);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(cleanup);
          aborted.push(path);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  };
  t.after(async () => {
    await app.close();
    globalThis.fetch = original;
  });
  await app.register(audioProxyRoutes, { requestTimeoutMs: 20 });
  const audio = createF317MeetingAudioPort(app, 'owner');
  await assert.rejects(audio.sources(), /504.*deadline/i);
  assert.equal(await audio.status(), null);
  const target = await audio.start({
    threadId: 'thread-1',
    meetingId: 'meeting-1',
    source: { id: 'Chrome', name: 'Chrome' },
  });
  await assert.rejects(audio.stop(target), /504.*deadline/i);
  await assert.rejects(audio.stop(target), /504.*deadline/i);
  assert.deepEqual(aborted, ['/sources', '/status', '/stop', '/stop']);
});
