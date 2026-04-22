import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---------- helpers to mock browser Location ---------- */

function stubLocation(overrides: Partial<Location> | null) {
  if (overrides === null) {
    vi.stubGlobal('location', undefined);
    return;
  }
  vi.stubGlobal('location', {
    hostname: overrides.hostname ?? 'localhost',
    port: overrides.port ?? '',
    protocol: overrides.protocol ?? 'http:',
    ...overrides,
  });
}

/* ---------- suite ---------- */

describe('resolveApiUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_API_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_API_URL;
    }
  });

  async function loadResolveApiUrl() {
    vi.resetModules();
    const mod = await import('../api-client');
    return mod.resolveApiUrl;
  }

  // ── Cloudflare Tunnel ──

  it('returns Cloudflare API when hostname is cafe.clowder-ai.com', async () => {
    stubLocation({ hostname: 'cafe.clowder-ai.com', protocol: 'https:', port: '' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('https://api.clowder-ai.com');
  });

  // ── Explicit env (non-localhost) always wins ──

  it('uses NEXT_PUBLIC_API_URL when explicitly set to non-localhost', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    stubLocation({ hostname: '1.2.3.4', port: '' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('https://api.example.com');
  });

  // ── P1 fix: localhost env + remote access → skip env, auto-detect ──

  it('skips localhost env when accessed remotely (reverse proxy)', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    stubLocation({ hostname: '1.2.3.4', protocol: 'http:', port: '' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://1.2.3.4');
  });

  it('skips 127.0.0.1 env when accessed remotely', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3004';
    stubLocation({ hostname: '10.0.0.5', protocol: 'http:', port: '3001' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://10.0.0.5:3002');
  });

  // ── localhost env + local access → use env (no skip) ──

  it('uses localhost env when accessed locally', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    stubLocation({ hostname: 'localhost', port: '3001' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3004');
  });

  // ── No env, browser, reverse proxy (empty port) → same origin ──

  it('returns same-origin when port is empty (reverse proxy)', async () => {
    stubLocation({ hostname: '1.2.3.4', protocol: 'https:', port: '' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('https://1.2.3.4');
  });

  // ── No env, browser, direct port → port+1 ──

  it('derives API port from frontend port (3001→3002)', async () => {
    stubLocation({ hostname: '192.168.1.10', protocol: 'http:', port: '3001' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://192.168.1.10:3002');
  });

  it('derives API port for alpha convention (3011→3012)', async () => {
    stubLocation({ hostname: 'localhost', protocol: 'http:', port: '3011' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3012');
  });
});
