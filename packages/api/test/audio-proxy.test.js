import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'you';
  });
  await app.register(audioProxyRoutes);
  await app.ready();
  return app;
}

describe('audio proxy routes', () => {
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
});
