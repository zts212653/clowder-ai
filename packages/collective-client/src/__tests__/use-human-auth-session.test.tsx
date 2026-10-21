// @vitest-environment jsdom

import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '../client-types.js';
import { useHumanAuthSession } from '../use-human-auth-session.js';

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
  history.replaceState(null, '', '/#bootstrap=test');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
