// @vitest-environment jsdom

import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '../client-types.js';
import { SESSION_KEY, useHumanAuthSession } from '../use-human-auth-session.js';

const meta = {
  serviceInstanceId: 'service-test',
  bootstrapNeeded: true,
  onboardingComplete: false,
  clientBuildId: 'test',
};
let root: Root;
let container: HTMLDivElement;
let session: ReturnType<typeof useHumanAuthSession>;
let current: ClientSnapshot;

function Harness() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>({
    phase: 'loading',
    events: [],
    providers: [],
    connection: 'online',
    delivery: { kind: 'idle' },
  });
  current = snapshot;
  session = useHumanAuthSession(snapshot, setSnapshot);
  return (
    <div>
      {snapshot.phase}: {snapshot.error}
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/#bootstrap=test');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

it('boots through a single-slot service even when StrictMode replays the effect', async () => {
  const firstBody = deferred<unknown>();
  let active = 0;
  let peak = 0;
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      paths.push(path);
      peak = Math.max(peak, ++active);
      const busy = active > 1;
      const first = paths.length === 1;
      return {
        ok: !busy,
        status: busy ? 503 : 200,
        json: async () => {
          const body = first ? await firstBody.promise : path === '/api/meta' ? meta : { providers: [] };
          active--;
          return busy ? { error: { message: 'BROWSER_SERVICE_BUSY' } } : body;
        },
      };
    }),
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  expect(paths).toEqual(['/api/meta']);
  await act(async () => firstBody.resolve(meta));
  expect(peak).toBe(1);
  expect(paths).toEqual(['/api/meta', '/api/meta', '/api/auth/providers']);
  expect(current.phase).toBe('entry');
  expect(current.meta).toEqual(meta);
  expect(current.error).toBeUndefined();
});

it('preserves FIFO and caller errors without replaying a failed write or sending an aborted queued request', async () => {
  const failedBody = deferred<unknown>();
  const fetcher = vi.fn(async (path: string) => ({
    ok: path !== '/api/write',
    status: path === '/api/write' ? 503 : 200,
    json: async () => (path === '/api/write' ? failedBody.promise : path === '/api/meta' ? meta : { providers: [] }),
  }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<Harness />));
  fetcher.mockClear();
  const abort = new AbortController();
  session.token.current = 'original-session';
  const failed = session.request('/api/write', { method: 'POST', body: '{}' });
  const cancelled = session.request('/api/cancelled', { signal: abort.signal });
  const later = session.request('/api/later');
  const outcomes = Promise.allSettled([failed, cancelled, later]);
  session.token.current = 'changed-session';
  abort.abort();
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/write']);
  let results: PromiseSettledResult<unknown>[] = [];
  await act(async () => {
    failedBody.resolve({ error: { message: 'BROWSER_SERVICE_BUSY' } });
    results = await outcomes;
  });
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { status: 503, message: 'BROWSER_SERVICE_BUSY' } });
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
  expect(results[2].status).toBe('fulfilled');
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/write', '/api/later']);
  expect(fetcher.mock.calls[1]).toMatchObject([
    '/api/later',
    { credentials: 'same-origin', headers: { authorization: 'Bearer original-session' } },
  ]);
});

it('rejects in-flight and queued requests from the previous Human after switching accounts', async () => {
  const slowBody = deferred<unknown>();
  const fetcher = vi.fn(async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => (path === '/api/slow' ? slowBody.promise : path === '/api/meta' ? meta : { providers: [] }),
  }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<Harness />));
  fetcher.mockClear();
  session.token.current = 'human-a-session';
  const inFlight = session.request('/api/slow');
  const queued = session.request('/api/must-not-run');

  await act(async () => {
    await Promise.resolve();
  });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/slow']);
  act(() => session.switchAccount());

  let outcomes: PromiseSettledResult<unknown>[] = [];
  await act(async () => {
    slowBody.resolve({ stale: true });
    outcomes = await Promise.allSettled([inFlight, queued]);
  });
  expect(outcomes).toEqual([
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: '身份已变化' }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: '身份已变化' }) }),
  ]);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/slow']);
  expect(session.token.current).toBeNull();
  expect(current.phase).toBe('entry');
});

it('switches back to the existing login path without erasing world, channel, or draft coordinates', async () => {
  const collectiveId = 'col_12345678';
  const storageKey = `${SESSION_KEY}:${location.origin}`;
  const draftKey = `collective-draft:service-test:${collectiveId}:human_12345678:general:channel`;
  history.replaceState(null, '', `/?collectiveId=${collectiveId}&channelId=general`);
  sessionStorage.setItem(storageKey, 'operator-session');
  localStorage.setItem(draftKey, JSON.stringify({ body: '切账号后也要留着' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify({ ...meta, bootstrapNeeded: false }));
      if (path === '/api/auth/providers') {
        return new Response(JSON.stringify({ providers: [{ id: 'github', ready: true }] }));
      }
      if (path === '/api/me') {
        return new Response(
          JSON.stringify({
            human: {
              humanId: 'human_12345678',
              displayName: 'You',
              createdAt: '2026-08-29T00:00:00.000Z',
            },
            auth: { provider: 'github', handle: 'zts212653' },
            collectives: [
              {
                collectiveId,
                name: '猫猫研究所',
                createdByHumanId: 'human_12345678',
                createdAt: '2026-08-29T00:00:00.000Z',
                role: 'steward',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  await act(async () => root.render(<Harness />));
  expect(current).toMatchObject({ phase: 'ready', me: { human: { displayName: 'You' } } });

  act(() => session.switchAccount());

  expect(session.token.current).toBeNull();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(localStorage.getItem(draftKey)).toContain('切账号后也要留着');
  expect(location.search).toBe(`?collectiveId=${collectiveId}&channelId=general`);
  expect(current).toMatchObject({ phase: 'entry', events: [], delivery: { kind: 'idle' } });
  expect(current.me).toBeUndefined();
  expect(current.collective).toBeUndefined();
});
