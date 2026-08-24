import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('apiFetch exact-GET coordination', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  async function loadApiFetch() {
    const mod = await import('../api-client');
    return mod.apiFetch;
  }

  it('shares one physical GET and gives each caller an independent Response clone', async () => {
    const business = deferred<Response>();
    const mockFetch = vi.fn((url: string) =>
      url.includes('/api/session') ? Promise.resolve(new Response('{}')) : business.promise,
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const first = apiFetch('/api/threads?view=sidebar');
    const second = apiFetch('/api/threads?view=sidebar');
    await vi.waitFor(() =>
      expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/threads'))).toHaveLength(1),
    );

    business.resolve(new Response(JSON.stringify({ generation: 1 }), { status: 200 }));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse).not.toBe(secondResponse);
    await expect(firstResponse.json()).resolves.toEqual({ generation: 1 });
    await expect(secondResponse.json()).resolves.toEqual({ generation: 1 });
  });

  it('does not merge different query strings or request headers', async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return Promise.resolve(new Response(String(mockFetch.mock.calls.length)));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    await Promise.all([
      apiFetch('/api/threads?view=sidebar'),
      apiFetch('/api/threads?view=full'),
      apiFetch('/api/threads?view=sidebar', { headers: { authorization: 'Bearer one' } }),
      apiFetch('/api/threads?view=sidebar', { headers: { authorization: 'Bearer two' } }),
    ]);

    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/threads'))).toHaveLength(4);
  });

  it('lets one caller abort without cancelling the shared physical GET', async () => {
    const business = deferred<Response>();
    let physicalSignal: AbortSignal | null | undefined;
    const mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      physicalSignal = init?.signal;
      return business.promise;
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();

    const aborted = apiFetch('/api/threads', { signal: controller.signal });
    const surviving = apiFetch('/api/threads');
    await vi.waitFor(() =>
      expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/threads'))).toHaveLength(1),
    );
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(physicalSignal?.aborted).toBe(false);
    business.resolve(new Response('{}'));
    await expect(surviving).resolves.toMatchObject({ status: 200 });
  });

  it('does not start a physical GET for an already-aborted caller', async () => {
    const mockFetch = vi.fn((url: string) =>
      url.includes('/api/session') ? Promise.resolve(new Response('{}')) : Promise.resolve(new Response('{}')),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(apiFetch('/api/threads', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('queues exactly one trailing generation for concurrent causal invalidations', async () => {
    const generations = [deferred<Response>(), deferred<Response>()];
    let businessCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return generations[businessCalls++]?.promise ?? Promise.reject(new Error('unexpected generation'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const current = apiFetch('/api/threads?view=sidebar');
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const invalidatedOnce = apiFetch('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    const invalidatedTwice = apiFetch('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    expect(businessCalls).toBe(1);

    generations[0]?.resolve(new Response('current'));
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    generations[1]?.resolve(new Response('trailing'));

    await expect((await current).text()).resolves.toBe('current');
    await expect((await invalidatedOnce).text()).resolves.toBe('trailing');
    await expect((await invalidatedTwice).text()).resolves.toBe('trailing');
    expect(businessCalls).toBe(2);
  });

  it('settles each caller on its assigned generation under continuous invalidation', async () => {
    const generations = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let businessCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return generations[businessCalls++]?.promise ?? Promise.reject(new Error('unexpected generation'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const current = apiFetch('/api/threads');
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const firstInvalidation = apiFetch('/api/threads', undefined, { afterCurrentGet: true });
    generations[0]?.resolve(new Response('one'));
    await vi.waitFor(() => expect(businessCalls).toBe(2));

    const secondInvalidation = apiFetch('/api/threads', undefined, { afterCurrentGet: true });
    generations[1]?.resolve(new Response('two'));
    await expect((await firstInvalidation).text()).resolves.toBe('two');
    await vi.waitFor(() => expect(businessCalls).toBe(3));

    generations[2]?.resolve(new Response('three'));
    await expect((await secondInvalidation).text()).resolves.toBe('three');
    await expect((await current).text()).resolves.toBe('one');
  });

  it('never coordinates mutation requests', async () => {
    let postCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      postCalls += 1;
      return Promise.resolve(new Response('{}'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    await Promise.all([apiFetch('/api/threads', { method: 'POST' }), apiFetch('/api/threads', { method: 'POST' })]);

    expect(postCalls).toBe(2);
  });

  it('admits thread creation within two seconds during navigation and periodic read pressure', async () => {
    const maxConnections = 6;
    const serviceDelayMs = 250;
    let active = 0;
    let postIngressAt: number | null = null;
    const pending: Array<{
      url: string;
      init?: RequestInit;
      resolve(response: Response): void;
    }> = [];

    const drain = () => {
      while (active < maxConnections && pending.length > 0) {
        const request = pending.shift() as (typeof pending)[number];
        active += 1;
        if (request.init?.method === 'POST') postIngressAt = performance.now();
        const delay = request.url.includes('/api/session') ? 0 : serviceDelayMs;
        setTimeout(() => {
          active -= 1;
          request.resolve(new Response('{}', { status: 200 }));
          drain();
        }, delay);
      }
    };
    const mockFetch = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, init, resolve });
          drain();
        }),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const clickedAt = performance.now();

    const navigationReads = Array.from({ length: 15 }, (_, index) => apiFetch(`/api/navigation/${index}`));
    const periodicReads = Array.from({ length: 7 }, (_, source) =>
      Array.from({ length: 4 }, () => apiFetch(`/api/poll/${source}`)),
    ).flat();
    const create = apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'liveness fixture' }),
    });

    await create;
    expect(postIngressAt).not.toBeNull();
    expect((postIngressAt ?? Number.POSITIVE_INFINITY) - clickedAt).toBeLessThan(2_000);
    expect(
      mockFetch.mock.calls.filter(([url, init]) => !String(url).includes('/api/session') && init?.method !== 'POST'),
    ).toHaveLength(22);
    await Promise.all([...navigationReads, ...periodicReads]);
  }, 5_000);
});
