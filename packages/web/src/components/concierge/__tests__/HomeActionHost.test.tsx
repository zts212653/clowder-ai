import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HomeActionHost } from '../HomeActionHost';

const transport = vi.hoisted(() => ({
  id: 'registered-socket',
  connected: false,
  listeners: new Map<string, (...args: unknown[]) => void>(),
  on: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: () => transport }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../shell/useSettingsSourceReturn', () => ({ useSettingsReadingEntry: () => vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://127.0.0.1:5493', apiFetch: vi.fn() }));

beforeEach(() => {
  transport.connected = false;
  transport.connect.mockClear();
  transport.disconnect.mockClear();
  transport.listeners.clear();
  transport.on.mockImplementation((event, listener) => transport.listeners.set(event, listener));
  transport.connect.mockImplementation(() => {
    transport.connected = true;
    transport.listeners.get('connect')?.();
  });
  transport.disconnect.mockImplementation(() => {
    transport.connected = false;
  });
  vi.mocked(apiFetch).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

for (const boundary of ['unmount', 'disconnect'] as const) {
  it(`releases a window capability returned after ${boundary}, instead of retaining an absent consumer`, async () => {
    let finishRegistration: (response: Response) => void = () => {
      throw new Error('registration not started');
    };
    let clientId: string | undefined;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/api/session') return new Response('{}');
      if (init?.method === 'DELETE') return new Response('{}');
      clientId = JSON.parse(String(init?.body)).clientId;
      return new Promise<Response>((resolve) => {
        finishRegistration = resolve;
      });
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    try {
      await act(async () => {
        root.render(<HomeActionHost />);
      });
      expect(clientId).toBeTruthy();
      if (boundary === 'unmount') {
        act(() => root.unmount());
        mounted = false;
      } else {
        transport.connected = false;
        transport.listeners.get('disconnect')?.();
      }
      await act(async () => {
        finishRegistration(
          new Response(JSON.stringify({ clientToken: 'late-private-token', expiresAt: Date.now() + 1000 })),
        );
      });
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.some(
            ([path, init]) =>
              path === `/api/concierge/home/clients/${clientId}` &&
              init?.method === 'DELETE' &&
              JSON.parse(String(init.body)).clientToken === 'late-private-token',
          ),
      ).toBe(true);
    } finally {
      if (mounted) act(() => root.unmount());
      container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
}

async function mountHost() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<HomeActionHost />));
  return () => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}

for (const event of ['online', 'pageshow']) {
  for (const failure of ['network', 'unhealthy']) {
    it(`recovers a ${failure} session bootstrap on ${event} without reloading the shell`, async () => {
      let sessions = 0;
      vi.mocked(apiFetch).mockImplementation(async (path) => {
        if (path === '/api/session') {
          if (++sessions === 1) {
            if (failure === 'network') throw new TypeError('network unavailable');
            return new Response('{}', { status: 503 });
          }
          return new Response('{}');
        }
        return new Response(JSON.stringify({ clientToken: 'recovered-private-token', expiresAt: Date.now() + 1000 }));
      });
      const unmount = await mountHost();
      try {
        expect(sessions).toBe(1);
        expect(transport.connect).not.toHaveBeenCalled();
        await act(async () => window.dispatchEvent(new Event(event)));
        expect(sessions).toBe(2);
        expect(transport.connect).toHaveBeenCalledTimes(1);
        expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/concierge/home/clients')).toBe(true);
        await act(async () => window.dispatchEvent(new Event(event)));
        expect(sessions).toBe(2);
        expect(transport.connect).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    });
  }
}

it('shares one pending recovery between online and pageshow signals', async () => {
  let sessions = 0;
  let finish: (response: Response) => void = () => {
    throw new Error('recovery not started');
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') {
      if (++sessions === 1) throw new TypeError('network unavailable');
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return new Response(JSON.stringify({ clientToken: 'recovered-private-token', expiresAt: Date.now() + 1000 }));
  });
  const unmount = await mountHost();
  try {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(sessions).toBe(2);
    await act(async () => finish(new Response('{}')));
    expect(transport.connect).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
  }
});

it('does not connect a hidden page from a late session bootstrap and recovers on return', async () => {
  let sessions = 0;
  let finish: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') {
      if (++sessions === 1)
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return new Response('{}');
    }
    return new Response(JSON.stringify({ clientToken: 'returned-private-token', expiresAt: Date.now() + 1000 }));
  });
  const unmount = await mountHost();
  try {
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      finish(new Response('{}'));
    });
    expect(transport.connect).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(sessions).toBe(2);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
  }
});

it('never connects or bootstraps again after the shell has unmounted', async () => {
  let finish: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const unmount = await mountHost();
  unmount();
  await act(async () => {
    finish(new Response('{}'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(transport.connect).not.toHaveBeenCalled();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('registers the actual connected socket with the owner HTTP window capability', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session' || init?.method === 'DELETE') return new Response('{}');
    const body = JSON.parse(String(init?.body));
    expect(body.socketId).toBe(transport.id);
    return new Response(JSON.stringify({ clientToken: 'owner-private-token', expiresAt: Date.now() + 1000 }));
  });
  const unmount = await mountHost();
  try {
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/concierge/home/clients')).toBe(true);
  } finally {
    unmount();
  }
});

it('renews an expired lease on discovery over the existing socket without reloading or sending', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  let registrations = 0;
  let observed: { clientToken?: string } | null = null;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session' || init?.method === 'DELETE') return new Response('{}');
    expect(path).toBe('/api/concierge/home/clients');
    expect(JSON.parse(String(init?.body)).socketId).toBe(transport.id);
    return new Response(
      JSON.stringify({ clientToken: `owner-token-${++registrations}`, expiresAt: now + 8 * 60 * 60 * 1000 }),
    );
  });
  const unmount = await mountHost();
  try {
    expect(registrations).toBe(1);
    now += 8 * 60 * 60 * 1000 + 1;
    await act(async () =>
      transport.listeners.get('home:inspect')?.({}, (state: typeof observed) => {
        observed = state;
      }),
    );
    expect(registrations).toBe(2);
    expect(observed).toMatchObject({ clientToken: 'owner-token-2' });
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes('/messages'))).toBe(false);
  } finally {
    unmount();
    clock.mockRestore();
  }
});
