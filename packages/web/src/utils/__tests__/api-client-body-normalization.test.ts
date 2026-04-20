import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bare POST through Cloudflare Tunnel → Fastify returns 415.
 * apiFetch should auto-add content-type + empty body for mutating
 * requests that omit a body. (Bug-12 root cause)
 */
describe('apiFetch body normalization for mutating requests', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  async function loadApiFetch() {
    vi.resetModules();
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
    const mod = await import('../api-client');
    return mod.apiFetch;
  }

  it('adds content-type and empty body to bare POST', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/threads/t1/read/latest', { method: 'POST' });

    // Skip session call, check the data call
    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    expect(dataCalls.length).toBe(1);
    const init = dataCalls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('adds content-type and empty body to bare DELETE', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/threads/t1', { method: 'DELETE' });

    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    const init = dataCalls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('does NOT override body when caller provides one', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    const init = dataCalls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('does NOT override FormData body (voice upload)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const formData = new FormData();
    formData.append('file', new Blob(['audio']), 'recording.webm');

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/whisper', {
      method: 'POST',
      body: formData,
    });

    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    const init = dataCalls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('does NOT add body to GET requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/threads');

    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    const init = dataCalls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('preserves caller headers while adding content-type for bare POST', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const apiFetch = await loadApiFetch();
    await apiFetch('/api/mark-all', {
      method: 'POST',
      headers: { 'x-custom': 'value' },
    });

    const dataCalls = mockFetch.mock.calls.filter((call) => !(call[0] as string).includes('/api/session'));
    const init = dataCalls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-custom']).toBe('value');
  });
});
