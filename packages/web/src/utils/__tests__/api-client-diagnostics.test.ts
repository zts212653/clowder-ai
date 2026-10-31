import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('request and notification diagnostic correlation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('location', { hostname: 'localhost', port: '3001', protocol: 'http:' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('joins a lost mutation reply to its notice without recording private request or error text', async () => {
    const lostReply = new TypeError('private provider failure text');
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/api/session')) return Response.json({ csrfToken: 'fixture-csrf' });
      if (String(url).endsWith('/api/diagnostics/connection')) return new Response(null, { status: 204 });
      throw lostReply;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api-client');
    await expect(
      apiFetch('/api/messages?private=query-secret', {
        method: 'POST',
        body: JSON.stringify({ content: 'private message body' }),
      }),
    ).rejects.toBe(lostReply);
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/messages'));
    const clientRequestId = new Headers(request?.[1]?.headers).get('x-clowder-client-request');
    expect(clientRequestId).toMatch(/^[a-f0-9-]{36}$/i);
    await vi.advanceTimersByTimeAsync(5_000);
    const deliveries = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/diagnostics/connection'));
    expect(deliveries.length).toBeGreaterThan(0);
    const records = deliveries.flatMap(([, init]) => JSON.parse(String(init?.body)).events);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'http',
          state: 'failed',
          clientRequestId,
          route: 'messages',
          errorKind: 'network',
        }),
        expect.objectContaining({ kind: 'connection_notice', state: 'shown', clientRequestId }),
      ]),
    );
    expect(new Headers(deliveries[0]?.[1]?.headers).get('x-csrf-token')).toBe('fixture-csrf');
    expect(JSON.stringify(records)).not.toMatch(/query-secret|private message body|private provider failure text/);
  });

  it('adds correlation after exact GET sharing and gives a 401 retry a new physical request identity', async () => {
    let attempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/api/session')) return Response.json({ csrfToken: 'fixture-csrf' });
      attempts += 1;
      return Response.json({}, { status: attempts === 1 ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api-client');
    const path = '/api/threads/private-thread/artifacts?view=works';
    const results = await Promise.all([apiFetch(path), apiFetch(path)]);
    expect(results.every((response) => response.status === 200)).toBe(true);
    const physical = fetchMock.mock.calls.filter(([url]) => String(url).includes('/artifacts'));
    expect(physical).toHaveLength(2);
    const ids = physical.map(([, init]) => new Headers(init?.headers).get('x-clowder-client-request'));
    expect(ids.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('retains an outage report across reload and never recursively reports a failed delivery', async () => {
    let recovered = false;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/api/session')) return Response.json({ csrfToken: 'fixture-csrf' });
      if (!recovered) throw new TypeError('offline');
      return String(url).endsWith('/api/diagnostics/connection')
        ? new Response(null, { status: 204 })
        : Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = await import('../api-client');
    await expect(first.apiFetch('/api/messages', { method: 'POST' })).rejects.toThrow('offline');
    await vi.advanceTimersByTimeAsync(5_000);
    const saved = JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]');
    expect(saved.some((record: { kind: string }) => record.kind === 'connection_notice')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/diagnostics/connection'))).toHaveLength(1);
    recovered = true;
    vi.resetModules();
    const reloaded = await import('../api-client');
    await reloaded.apiFetch('/api/threads');
    await vi.advanceTimersByTimeAsync(5_000);
    const reports = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/diagnostics/connection'));
    expect(reports).toHaveLength(2);
    expect(JSON.parse(String(reports[1]?.[1]?.body)).events).toEqual(saved);
    expect(JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]')).toEqual([]);
  });
});
