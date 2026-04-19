/**
 * F156 Phase D-2: Anti-Clickjacking Security Headers
 * F156 Phase D-6: DNS Rebinding Defense (Host header validation)
 *
 * D-2: Verifies X-Frame-Options: DENY + CSP frame-ancestors 'none'
 * D-6: Verifies Host header validation rejects non-localhost hosts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

const { securityHeadersPlugin } = await import('../../dist/infrastructure/security-headers.js');

describe('F156 D-2: Security Headers', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(securityHeadersPlugin);
    app.get('/api/test', async () => ({ ok: true }));
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('sets X-Frame-Options: DENY on API responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('sets CSP frame-ancestors none on API responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'Content-Security-Policy header must be present');
    assert.ok(csp.includes("frame-ancestors 'none'"), `CSP must include frame-ancestors 'none', got: ${csp}`);
  });

  it('sets headers on non-API routes too (health)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
  });

  it('does not break response body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  });
});

// --- F156 D-6: DNS Rebinding Defense ---

describe('F156 D-6: Host Header Validation', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(securityHeadersPlugin);
    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('allows request with Host: localhost:3004', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'localhost:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows request with Host: 127.0.0.1:3004', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '127.0.0.1:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows request with Host: localhost (no port)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'localhost' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows request with Host: [::1]:3004 (IPv6 loopback)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '[::1]:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('rejects request with Host: evil.com:3004 (DNS rebinding)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'evil.com:3004' } });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.includes('Host'), 'Should mention Host in error');
  });

  it('rejects request with Host: attacker.local:3004', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'attacker.local:3004' } });
    assert.equal(res.statusCode, 403);
  });
});

// --- F156 D-6 R2: Host allowlist derived from CORS origins ---

describe('F156 D-6: Host derived from configured origins', () => {
  let app;

  before(async () => {
    app = Fastify();
    // Simulate FRONTEND_URL configured to a custom domain
    await app.register(securityHeadersPlugin, {
      allowedOrigins: ['http://localhost:3003', 'https://cafe.clowder-ai.com'],
    });
    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('allows Host matching a configured origin hostname', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'cafe.clowder-ai.com' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows Host matching configured origin hostname with port', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'cafe.clowder-ai.com:443' } });
    assert.equal(res.statusCode, 200);
  });

  it('still allows localhost even with custom origins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'localhost:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('still rejects unknown hosts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'evil.com:3004' } });
    assert.equal(res.statusCode, 403);
  });
});

// --- F156 D-6: Private network Host validation (CORS_ALLOW_PRIVATE_NETWORK) ---

describe('F156 D-6: Private network Host allowed when CORS_ALLOW_PRIVATE_NETWORK=true', () => {
  let app;

  before(async () => {
    const { PRIVATE_NETWORK_ORIGIN } = await import('../../dist/config/frontend-origin.js');
    app = Fastify();
    // Simulate: CORS_ALLOW_PRIVATE_NETWORK=true adds the RegExp to origins
    await app.register(securityHeadersPlugin, {
      allowedOrigins: ['http://localhost:3003', PRIVATE_NETWORK_ORIGIN],
    });
    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('allows Host: 192.168.1.88:3004 (LAN access from phone)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '192.168.1.88:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows Host: 10.0.0.5:3004 (10.x private network)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '10.0.0.5:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows Host: 100.64.1.2:3004 (Tailscale CGNAT)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '100.64.1.2:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows Host: 172.16.0.1:3004 (172.16-31.x private network)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '172.16.0.1:3004' } });
    assert.equal(res.statusCode, 200);
  });

  it('still rejects non-private Host even with private network enabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'evil.com:3004' } });
    assert.equal(res.statusCode, 403);
  });

  it('still rejects public IPs (not in RFC 1918/Tailscale range)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: '8.8.8.8:3004' } });
    assert.equal(res.statusCode, 403);
  });
});

// --- F156 D-6 R3: Split-host API deployment (NEXT_PUBLIC_API_URL) ---

describe('F156 D-6: Split-host API deployment', () => {
  let app;

  before(async () => {
    app = Fastify();
    // Simulate: frontend at cafe.clowder-ai.com, API at api.clowder-ai.com
    await app.register(securityHeadersPlugin, {
      allowedOrigins: ['http://localhost:3003', 'https://cafe.clowder-ai.com'],
      apiBaseUrl: 'https://api.clowder-ai.com',
    });
    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('allows Host matching API base URL hostname', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'api.clowder-ai.com' } });
    assert.equal(res.statusCode, 200);
  });

  it('allows API hostname with explicit port', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'api.clowder-ai.com:443' } });
    assert.equal(res.statusCode, 200);
  });

  it('still allows frontend origin host', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'cafe.clowder-ai.com' } });
    assert.equal(res.statusCode, 200);
  });

  it('still rejects unknown hosts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test', headers: { host: 'evil.com' } });
    assert.equal(res.statusCode, 403);
  });
});
