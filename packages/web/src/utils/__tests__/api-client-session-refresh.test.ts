import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('HTTP authority before a physical Socket handshake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('location', { hostname: 'localhost', port: '3001', protocol: 'http:' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces concurrent reconnects and holds API reads behind the fresh cookie', async () => {
    const fresh = deferred<Response>();
    let sessionCalls = 0;
    const fetch = vi.fn((url: string) => {
      if (url.endsWith('/api/session'))
        return ++sessionCalls === 1 ? Promise.resolve(new Response('{}')) : fresh.promise;
      return Promise.resolve(new Response('{}'));
    });
    vi.stubGlobal('fetch', fetch);
    const { apiFetch, refreshApiSession } = await import('../api-client');
    await apiFetch('/api/first');
    const first = refreshApiSession();
    const second = refreshApiSession();
    const pending = apiFetch('/api/approval-hub/pending');
    expect(first).toBe(second);
    await vi.waitFor(() => expect(sessionCalls).toBe(2));
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/api/approval-hub/pending'))).toBe(false);
    fresh.resolve(new Response('{}'));
    await Promise.all([first, second, pending]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/api/approval-hub/pending'))).toHaveLength(1);
  });

  it('finishes an older bootstrap before issuing the post-disconnect refresh', async () => {
    const old = deferred<Response>();
    let sessionCalls = 0;
    const fetch = vi.fn((url: string) => {
      if (url.endsWith('/api/session')) return ++sessionCalls === 1 ? old.promise : Promise.resolve(new Response('{}'));
      return Promise.resolve(new Response('{}'));
    });
    vi.stubGlobal('fetch', fetch);
    const { apiFetch, refreshApiSession } = await import('../api-client');
    const initial = apiFetch('/api/first');
    const reconnect = refreshApiSession();
    await Promise.resolve();
    expect(sessionCalls).toBe(1);
    old.resolve(new Response('{}'));
    await Promise.all([initial, reconnect]);
    expect(sessionCalls).toBe(2);
  });

  it('does not authorize a failed refresh and allows a later bounded retry', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: ++calls === 1 ? 503 : 200 })),
    );
    const { refreshApiSession } = await import('../api-client');
    await expect(refreshApiSession()).rejects.toThrow('503');
    await expect(refreshApiSession()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
