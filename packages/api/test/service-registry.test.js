import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getKnownServices, getServiceById, resolveHealthUrl } from '../dist/domains/services/service-registry.js';

describe('service-registry', () => {
  it('returns all known services', () => {
    const services = getKnownServices();
    assert.ok(services.length >= 5);
    const ids = services.map((s) => s.id);
    assert.ok(ids.includes('whisper-stt'));
    assert.ok(ids.includes('mlx-tts'));
    assert.ok(ids.includes('embedding-model'));
    assert.ok(ids.includes('playwright'));
  });

  it('finds a service by id', () => {
    const svc = getServiceById('whisper-stt');
    assert.ok(svc);
    assert.equal(svc.port, 9876);
    assert.equal(svc.type, 'python');
    assert.ok(svc.enablesFeatures.includes('voice-input'));
  });

  it('returns undefined for unknown id', () => {
    assert.equal(getServiceById('nonexistent'), undefined);
  });

  it('each service has required manifest fields', () => {
    for (const svc of getKnownServices()) {
      assert.ok(svc.id);
      assert.ok(svc.name);
      assert.ok(['python', 'node', 'binary'].includes(svc.type));
      assert.ok(Array.isArray(svc.enablesFeatures));
      assert.ok(Array.isArray(svc.configVars));
    }
  });

  it('python services have health endpoints and ports', () => {
    const pythonServices = getKnownServices().filter((s) => s.type === 'python');
    assert.ok(pythonServices.length > 0);
    for (const svc of pythonServices) {
      assert.ok(svc.port > 0);
      assert.equal(svc.healthEndpoint, '/health');
    }
  });
});

describe('resolveHealthUrl', () => {
  it('uses port-only env var to construct health URL', () => {
    const saved = process.env.EMBED_PORT;
    const savedUrl = process.env.EMBED_URL;
    delete process.env.EMBED_URL;
    process.env.EMBED_PORT = '9999';
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9999/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (saved !== undefined) process.env.EMBED_PORT = saved;
      else delete process.env.EMBED_PORT;
    }
  });

  it('prefers URL env var over port env var', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    process.env.EMBED_URL = 'http://custom-host:8080';
    process.env.EMBED_PORT = '9999';
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://custom-host:8080/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
      else delete process.env.EMBED_PORT;
    }
  });

  it('falls back to manifest default port when no env vars set', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    delete process.env.EMBED_URL;
    delete process.env.EMBED_PORT;
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9880/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
    }
  });
});
