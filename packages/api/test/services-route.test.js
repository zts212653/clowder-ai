import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import { servicesRoutes } from '../dist/routes/services.js';

const testConfigDir = mkdtempSync(join(tmpdir(), 'services-test-'));
process.env.CAT_CAFE_SERVICES_CONFIG = join(testConfigDir, 'services.json');

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
const TRUSTED_ORIGIN_HEADERS = { origin: 'http://localhost:3003', host: 'localhost:3003' };
process.env.DEFAULT_OWNER_USER_ID = 'you';

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  const testEnv = options.env === undefined ? { ...process.env, CAT_CAFE_PROFILE: 'test' } : options.env;
  await app.register(servicesRoutes, {
    ...options,
    env: testEnv,
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
    setServiceConfig('whisper-stt', { installed: true, enabled: true });
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
      assert.equal(whisper.installable, true);
      assert.equal(typeof whisper.installed, 'boolean');
      assert.equal(typeof whisper.enabled, 'boolean');
      assert.equal('availableActions' in whisper, false);
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
      assert.equal(Object.keys(payload.endpoints).length, 6);
      assert.equal(payload.endpoints['whisper-stt'], 'http://127.0.0.1:19999/healthy');
      assert.equal(payload.endpoints['mlx-tts'], 'http://127.0.0.1:19998/unhealthy');
    } finally {
      await app.close();
    }
  });

  it('install preview suggests an available default service port', async () => {
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async (port) => (port === 9876 ? [5151] : []),
        serviceConfig: {
          get: () => undefined,
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/whisper-stt/install-preview',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(JSON.parse(res.payload).suggestedPort, 9877);
    } finally {
      await app.close();
    }
  });

  it('gates /api/services/endpoints behind the lifecycle owner check', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner';
    const app = await buildApp({
      env: { WHISPER_URL: 'https://user:secret@example.com/healthy' },
    });
    try {
      // Non-owner authenticated session: 403, no credentials returned.
      const nonOwnerRes = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: { 'x-test-session-user': 'someone-else' },
      });
      assert.equal(nonOwnerRes.statusCode, 403, nonOwnerRes.payload);
      assert.equal(nonOwnerRes.payload.includes('secret'), false);

      // Anonymous: 401.
      const anonRes = await app.inject({ method: 'GET', url: '/api/services/endpoints' });
      assert.equal(anonRes.statusCode, 401, anonRes.payload);

      // Owner: 200 with unmasked URL.
      const ownerRes = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: { 'x-test-session-user': 'owner' },
      });
      assert.equal(ownerRes.statusCode, 200, ownerRes.payload);
      assert.equal(JSON.parse(ownerRes.payload).endpoints['whisper-stt'], 'https://user:secret@example.com/healthy');
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('redacts URL credentials from display surfaces but keeps them on /endpoints', async () => {
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

      // Display surfaces (status panel + health probe response) stay masked.
      assert.equal(serviceEndpoint, 'https://***@example.com/healthy');
      assert.equal(healthEndpoint, 'https://***@example.com/healthy');
      assert.equal(serviceEndpoint.includes('secret'), false);
      assert.equal(healthEndpoint.includes('secret'), false);

      // /api/services/endpoints is the consumption surface (useVoiceInput
      // posts STT/LLM-postprocess requests against the returned URL), so it
      // must keep credentials intact. Otherwise authenticated upstreams
      // configured via WHISPER_URL=https://user:pass@host would fail with
      // "***" in the wire request (codex P2 2026-05-26).
      assert.equal(endpointMapValue, 'https://user:secret@example.com/healthy');
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

  it('honors service-specific *_PORT env vars when URL envs are unset', async () => {
    const app = await buildApp({
      env: {
        WHISPER_PORT: '19981',
        TTS_PORT: '19982',
        EMBED_PORT: '19983',
        LLM_POSTPROCESS_PORT: '19984',
        AUDIO_SERVICE_PORT: '19985',
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(JSON.parse(res.payload).endpoints, {
        'whisper-stt': 'http://127.0.0.1:19981',
        'qwen3-asr': 'http://127.0.0.1:19981',
        'mlx-tts': 'http://127.0.0.1:19982',
        'embedding-model': 'http://127.0.0.1:19983',
        'llm-postprocess': 'http://127.0.0.1:19984',
        'audio-capture': 'http://127.0.0.1:19985',
      });
    } finally {
      await app.close();
    }
  });

  it('normalizes localhost sidecar URLs to IPv4 loopback before health probes', async () => {
    for (const id of ['whisper-stt', 'mlx-tts', 'llm-postprocess']) {
      setServiceConfig(id, { installed: true, enabled: true });
    }
    const probedUrls = new Map();
    const app = await buildApp({
      env: {
        WHISPER_URL: 'http://localhost:19991',
        TTS_URL: 'http://localhost:19992',
        NEXT_PUBLIC_LLM_POSTPROCESS_URL: 'http://localhost:19994',
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
      const services = Object.fromEntries(JSON.parse(res.payload).services.map((service) => [service.id, service]));
      assert.equal(services['whisper-stt'].endpoint, 'http://127.0.0.1:19991');
      assert.equal(services['mlx-tts'].endpoint, 'http://127.0.0.1:19992');
      assert.equal(services['llm-postprocess'].endpoint, 'http://127.0.0.1:19994');
      assert.equal(probedUrls.get('whisper-stt'), 'http://127.0.0.1:19991/health');
      assert.equal(probedUrls.get('mlx-tts'), 'http://127.0.0.1:19992/health');
      assert.equal(probedUrls.get('llm-postprocess'), 'http://127.0.0.1:19994/health');
    } finally {
      await app.close();
    }
  });

  it('probes service-specific health URLs instead of base endpoints', async () => {
    for (const id of ['whisper-stt', 'mlx-tts', 'embedding-model', 'llm-postprocess', 'audio-capture']) {
      setServiceConfig(id, { installed: true, enabled: true });
    }
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
    setServiceConfig('whisper-stt', { installed: true, enabled: true });
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
    setServiceConfig('whisper-stt', { installed: true, enabled: true });
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

  it('reports not_configured for services that are not installed and enabled', async () => {
    setServiceConfig('whisper-stt', { installed: false, enabled: false });
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
      assert.equal(whisper.status, 'not_configured');
      assert.equal(whisper.installable, true);
      assert.equal(typeof whisper.installed, 'boolean');
      assert.equal(typeof whisper.enabled, 'boolean');
      assert.equal('availableActions' in whisper, false);
    } finally {
      await app.close();
    }
  });

  it('does not probe health when service is not installed', async () => {
    setServiceConfig('whisper-stt', { installed: false, enabled: false });
    let probed = false;
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => {
        probed = true;
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
      assert.equal(JSON.parse(res.payload).status, 'not_configured');
      assert.equal(probed, false, 'should not probe health for non-installed service');
    } finally {
      await app.close();
    }
  });

  it('does not probe health when service is installed but disabled', async () => {
    setServiceConfig('whisper-stt', { installed: true, enabled: false });
    let probed = false;
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => {
        probed = true;
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
      assert.equal(JSON.parse(res.payload).status, 'not_configured');
      assert.equal(probed, false, 'should not probe health for disabled service');
    } finally {
      await app.close();
    }
  });

  it('probes health for legacy config with only enabled (no installed field)', async () => {
    setServiceConfig('whisper-stt', { enabled: true });
    let probed = false;
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => {
        probed = true;
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
      assert.equal(JSON.parse(res.payload).status, 'healthy');
      assert.equal(probed, true, 'should probe health for legacy enabled-only config');

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((s) => s.id === 'whisper-stt');
      assert.equal(whisper.installed, true, 'installed derived from enabled for installable services');
    } finally {
      await app.close();
    }
  });

  it('legacy config { enabled:false } treated as installed (config record exists)', async () => {
    setServiceConfig('whisper-stt', { enabled: false });
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
    });
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((s) => s.id === 'whisper-stt');
      assert.equal(whisper.installed, true, 'legacy disabled config should still be installed');
      assert.equal(whisper.enabled, false, 'enabled should be false');
      assert.equal(whisper.status, 'not_configured', 'installed but disabled = not probed');
    } finally {
      await app.close();
    }
  });

  it('model-only config from a failed install is not treated as installed', async () => {
    const freshConfigDir = mkdtempSync(join(tmpdir(), 'services-model-only-'));
    const prevConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
    process.env.CAT_CAFE_SERVICES_CONFIG = join(freshConfigDir, 'services.json');
    setServiceConfig('whisper-stt', { enabled: false, selectedModel: 'mlx-community/whisper-large-v3-turbo' });
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
    });
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((s) => s.id === 'whisper-stt');
      assert.equal(whisper.installed, false, 'selectedModel alone records intent, not an installed service');
      assert.equal(whisper.enabled, false);
      assert.equal(whisper.status, 'not_configured');
    } finally {
      await app.close();
      process.env.CAT_CAFE_SERVICES_CONFIG = prevConfig;
    }
  });

  it('exposes the persisted selected model for installed services', async () => {
    const freshConfigDir = mkdtempSync(join(tmpdir(), 'services-selected-model-'));
    const prevConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
    process.env.CAT_CAFE_SERVICES_CONFIG = join(freshConfigDir, 'services.json');
    setServiceConfig('embedding-model', {
      installed: true,
      enabled: false,
      selectedModel: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      port: 19993,
    });
    const app = await buildApp();
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const embedding = JSON.parse(listRes.payload).services.find((s) => s.id === 'embedding-model');
      assert.equal(
        embedding.selectedModel,
        'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
        'UI needs the installed model persisted in services.json',
      );
      assert.equal(embedding.installed, true);
      assert.equal(embedding.enabled, false);
    } finally {
      await app.close();
      process.env.CAT_CAFE_SERVICES_CONFIG = prevConfig;
    }
  });

  it('fresh service (no config record) treated as not installed', async () => {
    const freshConfigDir = mkdtempSync(join(tmpdir(), 'services-fresh-'));
    const prevConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
    process.env.CAT_CAFE_SERVICES_CONFIG = join(freshConfigDir, 'services.json');
    const app = await buildApp({
      env: { WHISPER_URL: 'http://127.0.0.1:19999/healthy' },
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
    });
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((s) => s.id === 'whisper-stt');
      assert.equal(whisper.installed, false, 'no config record = not installed');
      assert.equal(whisper.status, 'not_configured', 'not installed = not probed');
    } finally {
      process.env.CAT_CAFE_SERVICES_CONFIG = prevConfig;
      await app.close();
    }
  });

  it('audio-capture (scripted) requires install before treated as installed', async () => {
    setServiceConfig('audio-capture', { installed: false, enabled: true });
    const app = await buildApp({
      env: { AUDIO_SERVICE_URL: 'http://127.0.0.1:19995/healthy' },
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
    });
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const audioCap = JSON.parse(listRes.payload).services.find((s) => s.id === 'audio-capture');
      assert.equal(audioCap.installable, true, 'audio-capture now has install scripts');
      assert.equal(audioCap.installed, false, 'scripted service not installed until config.installed=true');
    } finally {
      await app.close();
    }
  });

  it('audio-capture treated as installed and probed when both installed and enabled', async () => {
    setServiceConfig('audio-capture', { installed: true, enabled: true });
    let probed = false;
    const app = await buildApp({
      env: { AUDIO_SERVICE_URL: 'http://127.0.0.1:19995/healthy' },
      fetchHealth: async () => {
        probed = true;
        return { ok: true, status: 200, error: null };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/audio-capture/health',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(JSON.parse(res.payload).status, 'healthy');
      assert.equal(probed, true, 'should probe health for installed+enabled service');
    } finally {
      await app.close();
    }
  });

  it('uses persisted custom ports for service endpoints and health probes', async () => {
    const freshConfigDir = mkdtempSync(join(tmpdir(), 'services-custom-ports-'));
    const prevConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
    process.env.CAT_CAFE_SERVICES_CONFIG = join(freshConfigDir, 'services.json');
    setServiceConfig('whisper-stt', { installed: true, enabled: true, port: 19991 });
    setServiceConfig('mlx-tts', { installed: true, enabled: true, port: 19992 });
    setServiceConfig('embedding-model', { installed: true, enabled: true, port: 19993 });
    setServiceConfig('llm-postprocess', { installed: true, enabled: true, port: 19994 });
    setServiceConfig('audio-capture', { installed: true, enabled: true, port: 19995 });
    const probedUrls = new Map();
    const app = await buildApp({
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
      const services = Object.fromEntries(JSON.parse(res.payload).services.map((service) => [service.id, service]));
      assert.equal(services['whisper-stt'].endpoint, 'http://127.0.0.1:19991');
      assert.equal(services['mlx-tts'].endpoint, 'http://127.0.0.1:19992');
      assert.equal(services['embedding-model'].endpoint, 'http://127.0.0.1:19993');
      assert.equal(services['llm-postprocess'].endpoint, 'http://127.0.0.1:19994');
      assert.equal(services['audio-capture'].endpoint, 'http://127.0.0.1:19995');
      assert.deepEqual(Object.fromEntries(probedUrls), {
        'whisper-stt': 'http://127.0.0.1:19991/health',
        'mlx-tts': 'http://127.0.0.1:19992/health',
        'embedding-model': 'http://127.0.0.1:19993/health',
        'llm-postprocess': 'http://127.0.0.1:19994/health',
        'audio-capture': 'http://127.0.0.1:19995/status',
      });
    } finally {
      await app.close();
      process.env.CAT_CAFE_SERVICES_CONFIG = prevConfig;
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
