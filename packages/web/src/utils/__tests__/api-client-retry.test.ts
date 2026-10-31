import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('apiFetch 401 retry', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    window.localStorage.removeItem('cat-cafe:shell-language');
    window.localStorage.removeItem('cat-cafe:shell-presentation');
  });

  async function loadApiModules() {
    vi.resetModules();
    // Stub location so resolveApiUrl picks a deterministic base
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
    const [apiClientMod, toastStoreMod] = await Promise.all([
      import('../api-client'),
      import('../../stores/toastStore'),
    ]);
    toastStoreMod.useToastStore.setState({ toasts: [] });
    return {
      apiFetch: apiClientMod.apiFetch,
      useToastStore: toastStoreMod.useToastStore,
    };
  }

  it('reports concurrent transport failures once without retrying a mutation', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/session')) return new Response('{}', { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock;
    const { apiFetch, useToastStore } = await loadApiModules();
    const results = await Promise.allSettled([
      apiFetch('/api/threads/t/queue/q/targets', { method: 'POST', body: '{}' }),
      apiFetch('/api/threads/t/queue'),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/targets'))).toHaveLength(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].title).toBe('后端连接异常');
  });

  it('does not report a caller abort as backend unavailability', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const { apiFetch, useToastStore } = await loadApiModules();
    const controller = new AbortController();
    controller.abort();
    await expect(apiFetch('/api/threads/t/queue', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('reports a lost response in the current English shell language', async () => {
    window.localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    window.localStorage.setItem('cat-cafe:shell-language', 'en');
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/session')) return new Response('{}', { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    const { apiFetch, useToastStore } = await loadApiModules();
    await expect(apiFetch('/api/messages')).rejects.toThrow('Failed to fetch');
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      title: 'Backend connection problem',
      message: 'No response was received. Check the service and refresh to confirm the result of your operation.',
    });
  });

  it('retries once after 401 by re-establishing session', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      // Session endpoint always succeeds
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      // First data call returns 401, second succeeds
      if (calls.filter((c) => c.includes('/api/messages')).length === 1) {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    // Should have called: session (init), messages (401), session (retry), messages (success)
    const sessionCalls = calls.filter((c) => c.includes('/api/session'));
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(sessionCalls.length).toBe(2);
    expect(messageCalls.length).toBe(2);
  });

  it('replaces the CSRF header with the refreshed session token on a mutation retry', async () => {
    let sessionAttempt = 0;
    let dataAttempt = 0;
    const observedCsrf: Array<string | null> = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) {
        sessionAttempt += 1;
        return Promise.resolve(Response.json({ csrfToken: `csrf-${sessionAttempt}` }));
      }
      dataAttempt += 1;
      observedCsrf.push(new Headers(init?.headers).get('x-csrf-token'));
      return Promise.resolve(new Response('{}', { status: dataAttempt === 1 ? 401 : 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const response = await apiFetch('/api/memory/people/person_1/actions', {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(observedCsrf).toEqual(['csrf-1', 'csrf-2']);
  });

  it('does not retry on non-401 errors', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(500);
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(messageCalls.length).toBe(1);
  });

  it('passes credentials: include on all requests including retry', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      // Always 401 to trigger retry path
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    await apiFetch('/api/test');

    // Every call should have credentials: 'include'
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.credentials).toBe('include');
    }
  });

  it('does not show an error toast when 401 self-heals on retry', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (calls.filter((c) => c.includes('/api/messages')).length === 1) {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch, useToastStore } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('shows a visible error toast when 401 persists after retry', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch, useToastStore } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(401);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('error');
    expect(toasts[0]?.title).toContain('会话');
  });

  it('retries session bootstrap on the next call after a bootstrap network failure', async () => {
    const calls: string[] = [];
    let sessionAttempts = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return Promise.reject(new Error('offline'));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();

    await expect(apiFetch('/api/messages')).rejects.toThrow('offline');
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    const sessionCalls = calls.filter((c) => c.includes('/api/session'));
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(sessionCalls.length).toBe(2);
    expect(messageCalls.length).toBe(1);
  });
});
