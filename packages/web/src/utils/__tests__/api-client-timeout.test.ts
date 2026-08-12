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

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
}

async function settledOutcome<T>(outcome: ReturnType<typeof observe<T>>) {
  return Promise.race([outcome, Promise.resolve({ kind: 'pending' as const })]);
}

describe('apiFetch bounded completion', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function loadApiFetch() {
    const mod = await import('../api-client');
    return mod.apiFetch;
  }

  it('rejects when the native session bootstrap fetch never settles, then allows a later retry', async () => {
    let sessionAttempts = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) return new Promise<Response>(() => undefined);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const firstRequest = apiFetch('/api/messages');
    const firstObserved = observe(firstRequest);
    await vi.runOnlyPendingTimersAsync();

    const firstOutcome = await settledOutcome(firstObserved);
    expect(firstOutcome).toMatchObject({
      kind: 'rejected',
      error: { name: 'TimeoutError' },
    });

    await expect(apiFetch('/api/messages')).resolves.toMatchObject({ status: 200 });
    expect(sessionAttempts).toBe(2);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/messages'))).toHaveLength(1);
  });

  it('rejects when a business request fetch never settles', async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}', { status: 200 }));
      return new Promise<Response>(() => undefined);
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const request = apiFetch('/api/config/message-disposition', { method: 'PUT' });
    const observed = observe(request);
    await vi.runOnlyPendingTimersAsync();

    expect(await settledOutcome(observed)).toMatchObject({
      kind: 'rejected',
      error: { name: 'TimeoutError' },
    });
  });

  it('lets one caller abort while concurrent callers keep sharing the same session bootstrap', async () => {
    const session = deferred<Response>();
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return session.promise;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();

    const abortedRequest = apiFetch('/api/first', { signal: controller.signal });
    const abortedObserved = observe(abortedRequest);
    const survivingRequest = apiFetch('/api/second');
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(await settledOutcome(abortedObserved)).toMatchObject({
      kind: 'rejected',
      error: { name: 'AbortError' },
    });
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/session'))).toHaveLength(1);

    session.resolve(new Response('{}', { status: 200 }));
    await expect(survivingRequest).resolves.toMatchObject({ status: 200 });
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/second'))).toHaveLength(1);
  });

  it('honors caller abort during the 401 session refresh without issuing the retry request', async () => {
    const refreshedSession = deferred<Response>();
    let sessionAttempts = 0;
    let businessAttempts = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) return Promise.resolve(new Response('{}', { status: 200 }));
        return refreshedSession.promise;
      }
      businessAttempts += 1;
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();

    const request = apiFetch('/api/messages', { signal: controller.signal });
    const observed = observe(request);
    await vi.waitFor(() => expect(sessionAttempts).toBe(2));
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(await settledOutcome(observed)).toMatchObject({
      kind: 'rejected',
      error: { name: 'AbortError' },
    });
    expect(businessAttempts).toBe(1);

    refreshedSession.resolve(new Response('{}', { status: 200 }));
  });

  it('deduplicates concurrent 401 refreshes onto one replacement session gate', async () => {
    const refreshedSession = deferred<Response>();
    let sessionAttempts = 0;
    const businessAttempts = new Map<string, number>();
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) return Promise.resolve(new Response('{}', { status: 200 }));
        return refreshedSession.promise;
      }
      const attempts = (businessAttempts.get(url) ?? 0) + 1;
      businessAttempts.set(url, attempts);
      return Promise.resolve(new Response('{}', { status: attempts === 1 ? 401 : 200 }));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const first = apiFetch('/api/first');
    const second = apiFetch('/api/second');
    await vi.waitFor(() => expect(businessAttempts.size).toBe(2));
    await vi.waitFor(() => expect(sessionAttempts).toBe(2));
    expect(sessionAttempts).toBe(2);

    refreshedSession.resolve(new Response('{}', { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(sessionAttempts).toBe(2);
  });
});
