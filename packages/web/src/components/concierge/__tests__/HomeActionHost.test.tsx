import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeHubSocket, type FakeHubSocket, withHubSocket } from '@/test-utils/fake-hub-socket';
import { apiFetch } from '@/utils/api-client';
import { HomeActionHost } from '../HomeActionHost';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../shell/useSettingsSourceReturn', () => ({ useSettingsReadingEntry: () => vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://127.0.0.1:5493', apiFetch: vi.fn() }));

// The host rides the page connection owned by ThreadChatRuntimeProvider: connecting and
// session recovery are that runtime's job (useSocket-connection-recovery.test.tsx). The host
// registers a window lease for each connection and releases it whenever it can no longer serve.

let fake: FakeHubSocket;

beforeEach(() => {
  fake = createFakeHubSocket();
  vi.mocked(apiFetch).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const registrations = () =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/concierge/home/clients' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { clientId: string; socketId: string });

const releasedTokens = () =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(
      ([path, init]) => String(path).startsWith('/api/concierge/home/clients/') && init?.method === 'DELETE',
    )
    .map(([, init]) => JSON.parse(String(init?.body)).clientToken as string);

function grantLeases(token = (n: number) => `owner-token-${n}`, ttlMs = 1000) {
  let granted = 0;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'DELETE') return new Response('{}');
    return new Response(JSON.stringify({ clientToken: token(++granted), expiresAt: Date.now() + ttlMs }));
  });
}

async function mountHost() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = withHubSocket(createRoot(container), fake.hub);
  await act(async () => root.render(<HomeActionHost />));
  return () => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}

for (const boundary of ['unmount', 'disconnect'] as const) {
  it(`releases a window capability returned after ${boundary}, instead of retaining an absent consumer`, async () => {
    let finishRegistration: (response: Response) => void = () => {
      throw new Error('registration not started');
    };
    vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') return new Response('{}');
      return new Promise<Response>((resolve) => {
        finishRegistration = resolve;
      });
    });
    fake.connect();
    const unmount = await mountHost();
    let mounted = true;
    try {
      expect(registrations()).toHaveLength(1);
      if (boundary === 'unmount') {
        unmount();
        mounted = false;
      } else {
        act(() => fake.disconnect());
      }
      await act(async () => {
        finishRegistration(
          new Response(JSON.stringify({ clientToken: 'late-private-token', expiresAt: Date.now() + 1000 })),
        );
      });
      expect(releasedTokens()).toContain('late-private-token');
    } finally {
      if (mounted) unmount();
    }
  });
}

it('waits for the page connection and registers the actual connected socket', async () => {
  grantLeases();
  const unmount = await mountHost();
  try {
    expect(registrations()).toHaveLength(0);
    let socketId = '';
    await act(async () => {
      socketId = fake.connect();
    });
    expect(registrations().map((r) => r.socketId)).toEqual([socketId]);
  } finally {
    unmount();
  }
});

it('registers again with the new socket id after a reconnect and releases the old lease', async () => {
  grantLeases();
  const first = fake.connect();
  const unmount = await mountHost();
  try {
    let second = '';
    await act(async () => {
      fake.disconnect();
      second = fake.connect();
    });
    expect(registrations().map((r) => r.socketId)).toEqual([first, second]);
    expect(releasedTokens()).toEqual(['owner-token-1']);
  } finally {
    unmount();
  }
});

it('holds no lease while the page is hidden and registers again on return', async () => {
  grantLeases();
  fake.connect();
  const unmount = await mountHost();
  try {
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(releasedTokens()).toEqual(['owner-token-1']);
    await act(async () => {
      fake.disconnect();
      fake.connect();
    });
    expect(registrations()).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(registrations()).toHaveLength(2);
  } finally {
    unmount();
  }
});

for (const event of ['online', 'pageshow']) {
  it(`restores a missing lease on ${event} while connected, without a second registration in flight`, async () => {
    let calls = 0;
    vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') return new Response('{}');
      if (++calls === 1) throw new TypeError('network unavailable');
      return new Response(JSON.stringify({ clientToken: 'restored-token', expiresAt: Date.now() + 1000 }));
    });
    fake.connect();
    const unmount = await mountHost();
    try {
      expect(registrations()).toHaveLength(1);
      await act(async () => window.dispatchEvent(new Event(event)));
      expect(registrations()).toHaveLength(2);
      await act(async () => window.dispatchEvent(new Event(event)));
      expect(registrations()).toHaveLength(2);
    } finally {
      unmount();
    }
  });
}

it('never registers after the shell has unmounted', async () => {
  grantLeases();
  const unmount = await mountHost();
  unmount();
  await act(async () => {
    fake.connect();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(registrations()).toHaveLength(0);
  expect(fake.listenerCount('home:execute')).toBe(0);
});

it('renews an expired lease on discovery over the existing connection without sending', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  grantLeases(undefined, 8 * 60 * 60 * 1000);
  const socketId = fake.connect();
  let observed: { clientToken?: string } | null = null;
  const unmount = await mountHost();
  try {
    expect(registrations()).toHaveLength(1);
    now += 8 * 60 * 60 * 1000 + 1;
    await act(async () =>
      fake.deliver('home:inspect', {}, (state: typeof observed) => {
        observed = state;
      }),
    );
    expect(registrations().map((r) => r.socketId)).toEqual([socketId, socketId]);
    expect(observed).toMatchObject({ clientToken: 'owner-token-2' });
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('/messages'))).toBe(false);
  } finally {
    unmount();
    clock.mockRestore();
  }
});
