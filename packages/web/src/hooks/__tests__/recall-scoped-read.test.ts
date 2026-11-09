import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('recall reads over the actual session and GET transport', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('location', { hostname: 'localhost', port: '3011', protocol: 'http:' });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('shares a pending JSON read, lets one consumer leave and revalidates after it settles', async () => {
    const firstResponse = deferred<Response>();
    let reads = 0;
    let physicalSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{"userId":"owner-one"}'));
      if (!url.includes('/api/threads/one/memory-cues')) return Promise.resolve(new Response('{}'));
      reads++;
      physicalSignal = init?.signal;
      return reads === 1 ? firstResponse.promise : Promise.resolve(new Response('{"read":2}'));
    }) as typeof fetch;
    const { refreshApiSession } = await import('@/utils/api-client');
    await refreshApiSession();
    const { readScopedRecallJson } = await import('../recall-scoped-read');
    const leaving = new AbortController();
    const staying = new AbortController();
    const first = readScopedRecallJson(
      '/api/threads/one/memory-cues?invocationIds=%5B%22a%22%5D',
      'v1',
      leaving.signal,
    ).then(
      () => 'unexpected',
      (error: Error) => error.name,
    );
    const second = readScopedRecallJson(
      '/api/threads/one/memory-cues?invocationIds=%5B%22a%22%5D',
      'v1',
      staying.signal,
    );
    await vi.waitFor(() => expect(reads).toBe(1));
    leaving.abort();
    await expect(first).resolves.toBe('AbortError');
    expect(physicalSignal?.aborted).toBe(false);
    firstResponse.resolve(new Response('{"read":1}'));
    await expect(second).resolves.toEqual({ read: 1 });
    await expect(
      readScopedRecallJson('/api/threads/one/memory-cues?invocationIds=%5B%22a%22%5D', 'v1', staying.signal),
    ).resolves.toEqual({ read: 2 });
    expect(reads).toBe(2);
  });

  it('a new owner never joins the old owner physical GET generation for the same path', async () => {
    const oldResponse = deferred<Response>();
    let owner = 'owner-one';
    let reads = 0;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response(JSON.stringify({ userId: owner })));
      if (!url.includes('/api/recall/events')) return Promise.resolve(new Response('{}'));
      reads++;
      return reads === 1 ? oldResponse.promise : Promise.resolve(new Response(JSON.stringify({ owner })));
    }) as typeof fetch;
    const { refreshApiSession } = await import('@/utils/api-client');
    await refreshApiSession();
    const { readScopedRecallJson } = await import('../recall-scoped-read');
    const first = readScopedRecallJson(
      '/api/recall/events?threadId=shared&limit=100',
      'same-view',
      new AbortController().signal,
    ).then(
      () => 'unexpected-publication',
      (error: Error) => error.name,
    );
    await vi.waitFor(() => expect(reads).toBe(1));
    owner = 'owner-two';
    await refreshApiSession();
    const second = readScopedRecallJson(
      '/api/recall/events?threadId=shared&limit=100',
      'same-view',
      new AbortController().signal,
    );
    oldResponse.resolve(new Response('{"owner":"owner-one"}'));
    await expect(first).resolves.toBe('AbortError');
    await expect(second).resolves.toEqual({ owner: 'owner-two' });
    expect(reads).toBe(2);
  });
});
