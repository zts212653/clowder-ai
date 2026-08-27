import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import { audioProxyRoutes } from '../dist/routes/audio-proxy.js';

const originalFetch = globalThis.fetch;
const originalServicesConfig = process.env.CAT_CAFE_SERVICES_CONFIG;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalServicesConfig === undefined) delete process.env.CAT_CAFE_SERVICES_CONFIG;
  else process.env.CAT_CAFE_SERVICES_CONFIG = originalServicesConfig;
});

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'you';
    if (options.emitRequestCloseCompletion && request.url === '/api/audio/events') {
      setImmediate(() => request.raw.emit('close'));
    }
  });
  await app.register(audioProxyRoutes);
  await app.ready();
  return app;
}

describe('audio proxy routes', () => {
  it('requires a thread-bound controller lease before starting active capture', async () => {
    const fetchMock = mock.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/audio/start',
        payload: { source: 'mic' },
      });

      assert.equal(res.statusCode, 400, res.payload);
      assert.match(JSON.parse(res.payload).error, /thread_id.*required/i);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      await app.close();
    }
  });

  it('forwards N input contracts while keeping the sidecar token private', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'api-only-secret',
            status: { running: true, inputs: [{ id: 'meeting' }, { id: 'local' }] },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
    });
    const app = await buildApp();
    try {
      const inputs = [
        { id: 'meeting', source: 'app', app_name: 'WeLink', label: 'Remote meeting' },
        {
          id: 'local',
          source: 'mic',
          label: 'My microphone',
          speaker_evidence: {
            kind: 'exclusive_source',
            speaker_id: 'me',
            speaker_label: 'You',
          },
        },
      ];
      const res = await app.inject({
        method: 'POST',
        url: '/api/audio/start',
        payload: { inputs, thread_id: 'thread-1' },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(Object.hasOwn(JSON.parse(res.payload), 'lease_token'), false);
      assert.deepEqual(calls[0].body.inputs, inputs);
      assert.match(calls[0].body.controller_id, /^api-runtime:/);
    } finally {
      await app.close();
    }
  });

  it('renews the runtime lease and finalizes capture during graceful API shutdown', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method, body });
      if (url.endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'lease-secret',
            status: { running: true, thread_id: 'thread-1' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audio/start',
      payload: { source: 'mic', thread_id: 'thread-1' },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(Object.hasOwn(JSON.parse(res.payload), 'lease_token'), false);
    assert.equal(calls[0].url.endsWith('/start'), true);
    assert.equal(calls[0].body.thread_id, 'thread-1');
    assert.match(calls[0].body.controller_id, /^api-runtime:/);
    assert.equal(typeof calls[0].body.lease_ttl_s, 'number');

    const pause = await app.inject({ method: 'POST', url: '/api/audio/pause' });
    const resume = await app.inject({ method: 'POST', url: '/api/audio/resume' });
    assert.equal(pause.statusCode, 200, pause.payload);
    assert.equal(resume.statusCode, 200, resume.payload);
    assert.deepEqual(calls.find((call) => call.url.endsWith('/pause')).body, { lease_token: 'lease-secret' });
    assert.deepEqual(calls.find((call) => call.url.endsWith('/resume')).body, { lease_token: 'lease-secret' });

    await app.close();

    const stop = calls.find((call) => call.url.endsWith('/stop'));
    assert.ok(stop, `graceful shutdown must finalize active capture: ${JSON.stringify(calls)}`);
    assert.deepEqual(stop.body, { lease_token: 'lease-secret', reason: 'runtime-graceful-shutdown' });
  });

  it('lets an expired controller lease recover after the audio sidecar disappears', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    let startCalls = 0;
    Date.now = () => now;
    globalThis.fetch = mock.fn(async (url) => {
      if (url.endsWith('/start')) {
        startCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: `lease-${startCalls}`,
            status: { running: true, thread_id: `thread-${startCalls}` },
          }),
          { status: 200 },
        );
      }
      throw new Error('audio sidecar unavailable');
    });
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/audio/start',
        payload: { source: 'mic', thread_id: 'thread-1' },
      });
      assert.equal(first.statusCode, 200, first.payload);

      now += 20_000;
      const recovered = await app.inject({
        method: 'POST',
        url: '/api/audio/start',
        payload: { source: 'mic', thread_id: 'thread-2' },
      });

      assert.equal(recovered.statusCode, 200, recovered.payload);
      assert.equal(startCalls, 2);
    } finally {
      await app.close();
      Date.now = originalNow;
    }
  });

  it('does not send expired controller tokens to stop, pause, or resume', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    const calls = [];
    Date.now = () => now;
    globalThis.fetch = mock.fn(async (url) => {
      calls.push(url);
      if (url.endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'expired-api-lease',
            status: { running: true, thread_id: 'thread-1' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
    });
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/api/audio/start',
        payload: { source: 'mic', thread_id: 'thread-1' },
      });
      now += 20_000;

      for (const path of ['/api/audio/stop', '/api/audio/pause', '/api/audio/resume']) {
        const response = await app.inject({ method: 'POST', url: path });
        assert.equal(response.statusCode, 409, `${path}: ${response.payload}`);
      }
      assert.deepEqual(
        calls.filter((url) => !url.endsWith('/start')),
        [],
      );
    } finally {
      await app.close();
      Date.now = originalNow;
    }
  });

  it('proxies audio calls to the persisted audio-capture service port', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'audio-proxy-config-'));
    process.env.CAT_CAFE_SERVICES_CONFIG = join(configDir, 'services.json');
    delete process.env.AUDIO_SERVICE_URL;
    setServiceConfig('audio-capture', { enabled: true, installed: true, port: 19985 });
    const fetchMock = mock.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audio/status' });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(fetchMock.mock.calls[0].arguments[0], 'http://127.0.0.1:19985/status');
    } finally {
      await app.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('does not leak an unhandled rejection when the audio SSE client disconnects', async () => {
    const encoder = new TextEncoder();
    const unhandledRejections = [];
    const onUnhandledRejection = (reason) => {
      unhandledRejections.push(reason);
    };
    globalThis.fetch = mock.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: connected\n\n'));
          },
          cancel() {
            return Promise.reject(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      );
    });

    const app = await buildApp();
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.equal(typeof address, 'object');
      assert.ok(address);

      await new Promise((resolve, reject) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/audio/events',
          },
          (res) => {
            res.once('data', () => {
              res.destroy();
              req.destroy();
              setTimeout(resolve, 30);
            });
          },
        );
        req.once('error', reject);
        req.setTimeout(1000, () => {
          req.destroy(new Error('timed out waiting for SSE response'));
        });
      });

      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      await app.close();
    }
  });

  it('does not treat request close completion as an SSE client disconnect', async () => {
    const encoder = new TextEncoder();
    let upstreamSignal;
    globalThis.fetch = mock.fn(async (_url, init) => {
      upstreamSignal = init.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: first\n\n'));
            setTimeout(() => {
              if (!upstreamSignal.aborted) controller.enqueue(encoder.encode('data: second\n\n'));
            }, 30);
          },
        }),
        { status: 200 },
      );
    });

    const app = await buildApp({ emitRequestCloseCompletion: true });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.equal(typeof address, 'object');
      assert.ok(address);

      await new Promise((resolve, reject) => {
        let payload = '';
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          req.destroy();
          finish(new Error(`timed out waiting for second SSE frame; received ${JSON.stringify(payload)}`));
        }, 1000);
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/audio/events',
          },
          (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              payload += chunk;
              if (payload.includes('data: second\n\n')) {
                assert.equal(upstreamSignal.aborted, false);
                res.destroy();
                req.destroy();
                finish();
              }
            });
          },
        );
        req.once('error', finish);
      });
    } finally {
      await app.close();
    }
  });
});
