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

function stubRuntimeOrigin(apiOrigin: unknown) {
  vi.stubGlobal('document', { documentElement: { getAttribute: () => apiOrigin } });
}

describe('resolveApiUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it('uses the desktop runtime API instead of a production build-time localhost default', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    stubLocation({ hostname: 'localhost', port: '5158' });
    vi.stubGlobal('desktopBridge', { apiOrigin: 'http://localhost:3158' });
    expect((await loadResolveApiUrl())()).toBe('http://localhost:3158');
  });

  it.each([
    ['5196', '3196'],
    ['5128', '4117'],
  ])('initializes an ordinary browser on frontend %s with its independent runtime API %s', async (frontendPort, apiPort) => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    stubLocation({ hostname: 'localhost', port: frontendPort });
    stubRuntimeOrigin(`http://localhost:${apiPort}`);
    vi.resetModules();
    expect((await import('../api-client')).API_URL).toBe(`http://localhost:${apiPort}`);
  });

  it('aligns runtime API hostname for strict same-site session cookies', async () => {
    stubLocation({ hostname: '127.0.0.1', port: '5196' });
    stubRuntimeOrigin('http://localhost:3196');
    expect((await loadResolveApiUrl())()).toBe('http://127.0.0.1:3196');
  });

  it('retains Electron bridge priority over browser bootstrap', async () => {
    stubLocation({ hostname: 'localhost', port: '5196' });
    vi.stubGlobal('desktopBridge', { apiOrigin: 'http://localhost:3196' });
    stubRuntimeOrigin('http://localhost:4117');
    expect((await loadResolveApiUrl())()).toBe('http://localhost:3196');
  });

  it.each([
    'https://outside.invalid',
    'http://localhost:3196/api',
    'http://u:p@localhost:3196',
    'http://localhost:0',
    '',
    null,
  ])('ignores an invalid runtime API origin %s', async (apiOrigin) => {
    stubLocation({ hostname: 'localhost', port: '5196' });
    stubRuntimeOrigin(apiOrigin);
    expect((await loadResolveApiUrl())()).toBe('http://localhost:5197');
  });

  it('does not route a remote browser to a bootstrapped loopback API', async () => {
    stubLocation({ hostname: 'cafe.example.test', protocol: 'https:', port: '' });
    stubRuntimeOrigin('http://localhost:3196');
    expect((await loadResolveApiUrl())()).toBe('https://cafe.example.test');
  });

  it('keeps SSR on the explicit runtime API port without relying on a document', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    stubLocation(null);
    vi.stubEnv('API_SERVER_PORT', '4117');
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    expect((await loadResolveApiUrl())()).toBe('http://localhost:4117');
  });
  it.each([
    'https://outside.invalid',
    'http://localhost:3158/api',
    'http://user:pass@localhost:3158',
  ])('rejects an unsafe desktop API origin %s', async (apiOrigin) => {
    stubLocation({ hostname: 'localhost', port: '5158' });
    vi.stubGlobal('desktopBridge', { apiOrigin });
    expect((await loadResolveApiUrl())()).toBe('http://localhost:5159');
  });

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
    stubLocation({ hostname: '10.0.0.5', protocol: 'http:', port: '3003' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://10.0.0.5:3004');
  });

  // ── localhost env + local access → use env (no skip) ──

  it('uses localhost env when accessed locally', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3004';
    stubLocation({ hostname: 'localhost', port: '3003' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3004');
  });

  it('uses the browser loopback hostname when the env points to localhost', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3012';
    stubLocation({ hostname: '127.0.0.1', protocol: 'http:', port: '3011' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://127.0.0.1:3012');
  });

  it('uses the browser loopback hostname when the env points to 127.0.0.1', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3012';
    stubLocation({ hostname: 'localhost', protocol: 'http:', port: '3011' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3012');
  });

  // ── Symmetric fix: cloud env + local access → skip env, hit local API
  //    (avoids forcing localhost browser through Cloudflare Tunnel round-trip)

  it('skips cloud env when accessed from localhost (avoids tunnel round-trip)', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.clowder-ai.com';
    stubLocation({ hostname: 'localhost', protocol: 'http:', port: '3003' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3004');
  });

  it('skips cloud env when accessed from 127.0.0.1', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.clowder-ai.com';
    stubLocation({ hostname: '127.0.0.1', protocol: 'http:', port: '3011' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://127.0.0.1:3012');
  });

  // ── No env, browser, reverse proxy (empty port) → same origin ──

  it('returns same-origin when port is empty (reverse proxy)', async () => {
    stubLocation({ hostname: '1.2.3.4', protocol: 'https:', port: '' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('https://1.2.3.4');
  });

  // ── No env, browser, direct port → port+1 ──

  it('derives API port from frontend port (3003→3004)', async () => {
    stubLocation({ hostname: '192.168.1.10', protocol: 'http:', port: '3003' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://192.168.1.10:3004');
  });

  it('derives API port for alpha convention (3011→3012)', async () => {
    stubLocation({ hostname: 'localhost', protocol: 'http:', port: '3011' });
    const resolve = await loadResolveApiUrl();
    expect(resolve()).toBe('http://localhost:3012');
  });
});
