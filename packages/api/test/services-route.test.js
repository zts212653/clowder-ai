import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
const TRUSTED_ORIGIN_HEADERS = { origin: 'http://localhost:3003', host: 'localhost:3003' };

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(servicesRoutes, {
    ...options,
    fetchHealth:
      options.fetchHealth ??
      (async (url) => ({
        ok: url.includes('healthy'),
        status: url.includes('healthy') ? 200 : 503,
        error: url.includes('healthy') ? null : 'unreachable',
      })),
  });
  await app.ready();
  return app;
}

describe('services routes', () => {
  it('requires identity for all service manifest reads', async () => {
    const app = await buildApp();
    try {
      for (const url of ['/api/services', '/api/services/endpoints', '/api/services/whisper-stt/health']) {
        const res = await app.inject({ method: 'GET', url });

        assert.equal(res.statusCode, 401, `${url} should require identity`);
        assert.match(JSON.parse(res.payload).error, /Authentication required/);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects trusted Origin fallback without an explicit session', async () => {
    const app = await buildApp();
    try {
      for (const url of ['/api/services', '/api/services/endpoints', '/api/services/whisper-stt/health']) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: TRUSTED_ORIGIN_HEADERS,
        });

        assert.equal(res.statusCode, 401, `${url} should not accept Origin-only identity`);
        assert.match(JSON.parse(res.payload).error, /Authentication required/);
      }
    } finally {
      await app.close();
    }
  });

  it('returns a read-only service manifest without lifecycle script handles', async () => {
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const payload = JSON.parse(res.payload);
      const whisper = payload.services.find((service) => service.id === 'whisper-stt');
      assert.ok(whisper, 'whisper-stt should be listed');
      assert.equal(whisper.endpoint, 'http://127.0.0.1:19999/healthy');
      assert.equal(whisper.configured, true);
      assert.equal(whisper.status, 'healthy');
      assert.deepEqual(whisper.availableActions, ['stop', 'uninstall']);
      assert.equal('scripts' in whisper, false);
      assert.equal('installScript' in whisper, false);
      assert.equal('startScript' in whisper, false);
      assert.equal('uninstallScript' in whisper, false);
    } finally {
      await app.close();
    }
  });

  it('returns the read-only service endpoint map', async () => {
    const app = await buildApp({
      env: {
        WHISPER_URL: 'http://127.0.0.1:19999/healthy',
        TTS_URL: 'http://127.0.0.1:19998/unhealthy',
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const payload = JSON.parse(res.payload);
      assert.equal(Object.keys(payload.endpoints).length, 5);
      assert.equal(payload.endpoints['whisper-stt'], 'http://127.0.0.1:19999/healthy');
      assert.equal(payload.endpoints['mlx-tts'], 'http://127.0.0.1:19998/unhealthy');
    } finally {
      await app.close();
    }
  });

  it('redacts URL credentials from client-visible service endpoints', async () => {
    const app = await buildApp({
      env: {
        WHISPER_URL: 'https://user:secret@example.com/healthy',
      },
    });
    try {
      const servicesRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const endpointsRes = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });
      const healthRes = await app.inject({
        method: 'GET',
        url: '/api/services/whisper-stt/health',
        headers: SESSION_HEADERS,
      });

      assert.equal(servicesRes.statusCode, 200, servicesRes.payload);
      assert.equal(endpointsRes.statusCode, 200, endpointsRes.payload);
      assert.equal(healthRes.statusCode, 200, healthRes.payload);

      const serviceEndpoint = JSON.parse(servicesRes.payload).services.find(
        (service) => service.id === 'whisper-stt',
      ).endpoint;
      const endpointMapValue = JSON.parse(endpointsRes.payload).endpoints['whisper-stt'];
      const healthEndpoint = JSON.parse(healthRes.payload).endpoint;

      assert.equal(serviceEndpoint, 'https://***@example.com/healthy');
      assert.equal(endpointMapValue, 'https://***@example.com/healthy');
      assert.equal(healthEndpoint, 'https://***@example.com/healthy');
      assert.equal(serviceEndpoint.includes('secret'), false);
      assert.equal(endpointMapValue.includes('secret'), false);
      assert.equal(healthEndpoint.includes('secret'), false);
    } finally {
      await app.close();
    }
  });

  it('returns service endpoints without running health probes', async () => {
    let probeCount = 0;
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => {
        probeCount += 1;
        throw new Error('endpoint map should not run health probes');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(JSON.parse(res.payload).endpoints['whisper-stt'], 'http://127.0.0.1:19999/healthy');
      assert.equal(probeCount, 0);
    } finally {
      await app.close();
    }
  });

  it('honors EMBED_PORT when EMBED_URL is unset', async () => {
    const app = await buildApp({
      env: { EMBED_PORT: '19980' },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(JSON.parse(res.payload).endpoints['embedding-model'], 'http://127.0.0.1:19980');
    } finally {
      await app.close();
    }
  });

  it('probes service-specific health URLs instead of base endpoints', async () => {
    const probedUrls = new Map();
    const app = await buildApp({
      env: {
        WHISPER_URL: 'http://127.0.0.1:19991',
        TTS_URL: 'http://127.0.0.1:19992',
        EMBED_URL: 'http://127.0.0.1:19993',
        NEXT_PUBLIC_LLM_POSTPROCESS_URL: 'http://127.0.0.1:19994',
        AUDIO_SERVICE_URL: 'http://127.0.0.1:19995',
      },
      fetchHealth: async (url, service) => {
        probedUrls.set(service.id, url);
        return { ok: true, status: 200, error: null };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(Object.fromEntries(probedUrls), {
        'whisper-stt': 'http://127.0.0.1:19991/health',
        'mlx-tts': 'http://127.0.0.1:19992/health',
        'embedding-model': 'http://127.0.0.1:19993/health',
        'llm-postprocess': 'http://127.0.0.1:19994/health',
        'audio-capture': 'http://127.0.0.1:19995/status',
      });
    } finally {
      await app.close();
    }
  });

  it('does not append duplicate health paths when endpoint already points at health', async () => {
    let probedUrl = null;
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/health' },
      fetchHealth: async (url) => {
        probedUrl = url;
        return { ok: true, status: 200, error: null };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/whisper-stt/health',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(probedUrl, 'http://127.0.0.1:19999/health');
    } finally {
      await app.close();
    }
  });

  it('returns positive health for a known configured service', async () => {
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/whisper-stt/health',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const payload = JSON.parse(res.payload);
      assert.equal(payload.id, 'whisper-stt');
      assert.equal(payload.endpoint, 'http://127.0.0.1:19999/healthy');
      assert.equal(payload.configured, true);
      assert.equal(payload.status, 'healthy');
      assert.equal(payload.httpStatus, 200);
      assert.equal(payload.error, null);
    } finally {
      await app.close();
    }
  });

  it('includes install in available actions for unhealthy services with scripts', async () => {
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/down' },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const whisper = JSON.parse(res.payload).services.find((s) => s.id === 'whisper-stt');
      assert.equal(whisper.status, 'unhealthy');
      assert.deepEqual(whisper.availableActions, ['install', 'start', 'uninstall']);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown service health lookups', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/not-a-service/health',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 404);
      assert.match(JSON.parse(res.payload).error, /not-a-service/);
    } finally {
      await app.close();
    }
  });
});
