import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('API outage notification lifecycle (#1881)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('location', { hostname: 'localhost', port: '5102', protocol: 'http:' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps one notice for a prolonged outage, including after the reader holds it open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline');
      }),
    );
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');

    await expect(apiFetch('/api/threads/t/active-pane')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];
    useToastStore.getState().disableAutoDismiss(first.id);

    await Array.from({ length: 12 }).reduce(async (previous) => {
      await previous;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(apiFetch('/api/concierge/desktop')).rejects.toThrow('offline');
    }, Promise.resolve());
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ id: first.id })]);
    expect(first.duration).toBe(0);
  });

  it('honors dismissal until a successful request ends the outage, then permits a new notice', async () => {
    let offline = true;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        if (offline) throw new TypeError('offline');
        return Response.json({});
      }),
    );
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');

    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];
    useToastStore.getState().removeToast(first.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    expect(useToastStore.getState().toasts).toEqual([]);

    offline = false;
    await expect(apiFetch('/api/threads')).resolves.toMatchObject({ status: 200 });
    offline = true;
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].id).not.toBe(first.id);
  });

  it('retains an unread outage notice when ten unrelated notifications arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline');
      }),
    );
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];
    Array.from({ length: 12 }, (_, index) =>
      useToastStore.getState().addToast({
        type: 'info',
        title: `Other ${index}`,
        message: 'Unrelated notification',
        duration: 5_000,
      }),
    );
    const notices = useToastStore.getState().toasts;
    expect(notices.find((toast) => toast.id === first.id)).toBeDefined();
    expect(notices.filter((toast) => toast.id !== first.id)).toHaveLength(10);
  });

  it('does not interrupt a connection notice that the user explicitly opened for reading', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];
    useToastStore.getState().disableAutoDismiss(first.id);
    fetchMock.mockImplementation(async () => Response.json({}));
    await apiFetch('/api/threads');
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ id: first.id, manualDismissOnly: true, title: '后端连接已恢复', type: 'info' }),
    ]);
    fetchMock.mockImplementation(async () => {
      throw new TypeError('offline again');
    });
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline again');
    const notices = useToastStore.getState().toasts;
    expect(notices).toHaveLength(2);
    expect(notices.filter((toast) => toast.title === '后端连接异常')).toHaveLength(1);
  });

  it('clears only the connection notice on successful recovery, preserving user-held notifications', async () => {
    let offline = true;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        if (offline) throw new TypeError('offline');
        return Response.json({});
      }),
    );
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');
    const held = useToastStore.getState().addToast({ type: 'info', title: 'Reading', message: 'Keep me', duration: 0 });
    useToastStore.getState().disableAutoDismiss(held);
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');

    offline = false;
    await apiFetch('/api/threads');
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ id: held })]);
  });

  it('keeps caller aborts separate from connection recovery and clears the notice on an HTTP 503 response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];

    const controller = new AbortController();
    controller.abort();
    await expect(apiFetch('/api/threads', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ id: first.id })]);
    fetchMock.mockImplementation(async (url) =>
      Response.json({}, { status: String(url).endsWith('/api/session') ? 200 : 503 }),
    );
    await expect(apiFetch('/api/threads')).resolves.toMatchObject({ status: 503 });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('keeps diagnostics-only success separate from recovery, and accepts a successful conditional GET', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch, sendMemberSaveDiagnostics } = await import('../api-client');
    const { useToastStore } = await import('../../stores/toastStore');
    await expect(apiFetch('/api/threads')).rejects.toThrow('offline');
    const first = useToastStore.getState().toasts[0];
    fetchMock.mockImplementation(async () => Response.json({}));
    await sendMemberSaveDiagnostics({ method: 'POST' });
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ id: first.id })]);

    fetchMock.mockImplementation(async () => new Response(null, { status: 304 }));
    await apiFetch('/api/threads', undefined, { ifNoneMatch: 'fixture' });
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
