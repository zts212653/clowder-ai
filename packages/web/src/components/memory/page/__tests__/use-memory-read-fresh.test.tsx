import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useMemoryPageTail } from '../use-memory-page-tail';
import { useMemoryRead } from '../use-memory-read';

it('rereads a changed memory after an earlier physical GET finishes, rather than reusing its old snapshot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let version = 'old-revision';
  let reads = 0;
  let resolveSnapshot: (response: Response) => void = () => {
    throw new Error('snapshot not requested');
  };
  const path = '/api/memory/profile';
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname;
      if (pathname === '/api/session') return response({ userId: 'owner', csrfToken: 'test-csrf' });
      if (pathname === `${path}/actions`) {
        version = 'new-revision';
        return response({ outcome: 'applied' });
      }
      if (pathname === path) {
        reads++;
        if (reads === 2)
          return new Promise<Response>((resolve) => {
            resolveSnapshot = resolve;
          });
        return response({ version });
      }
      throw new Error(`unexpected read: ${pathname}`);
    }),
  );
  function Memory() {
    const read = useMemoryRead<{ version: string }>(path);
    return (
      <>
        <output>{read.loading ? 'reading' : read.data?.version}</output>
        <button type="button" onClick={read.retry}>
          重读
        </button>
      </>
    );
  }
  try {
    await act(async () => root.render(<Memory />));
    expect(host.textContent).toContain('old-revision');
    const olderRead = apiFetch(path);
    await vi.waitFor(() => expect(reads).toBe(2));
    await apiFetch(`${path}/actions`, { method: 'POST' });
    await act(async () => host.querySelector('button')?.click());
    await act(async () => {
      resolveSnapshot(response({ version: 'old-revision' }));
      await olderRead;
    });
    expect(host.textContent).toContain('new-revision');
    expect(reads).toBe(3);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('gets a new physical continuation after refresh even when the cursor URL has not changed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const path = '/api/memory/matters?limit=12';
  let current = false;
  let pageReads = 0;
  let releaseOld: (value: Response) => void = () => {
    throw new Error('old page not requested');
  };
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      if (target.pathname === '/api/session') return response({ userId: 'owner', csrfToken: 'test-csrf' });
      if (init?.method === 'POST') {
        current = true;
        return response({ outcome: 'applied' });
      }
      if (target.searchParams.has('cursor')) {
        pageReads++;
        if (pageReads === 1)
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        return response({ items: ['new-tail'] });
      }
      return response({ items: [current ? 'new-first' : 'old-first'], nextCursor: 'same-cursor' });
    }),
  );
  function Pages() {
    const read = useMemoryRead<{ items: string[]; nextCursor?: string }>(path);
    const tail = useMemoryPageTail(path, read.data, (previous, next) => ({
      ...next,
      items: [...(previous?.items ?? []), ...next.items],
    }));
    return (
      <>
        <output>{[...(read.data?.items ?? []), ...(tail.data?.items ?? [])].join(',')}</output>
        <button type="button" onClick={read.retry}>
          refresh
        </button>
        <button type="button" onClick={() => void tail.loadMore()}>
          more
        </button>
      </>
    );
  }
  const click = async (text: string) =>
    act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)?.click());
  try {
    await act(async () => root.render(<Pages />));
    await click('more');
    await vi.waitFor(() => expect(pageReads).toBe(1));
    await apiFetch('/api/memory/matters/write', { method: 'POST' });
    await click('refresh');
    expect(host.textContent).toContain('new-first');
    await click('more');
    await act(async () => releaseOld(response({ items: ['old-tail'] })));
    expect(host.textContent).toContain('new-tail');
    expect(host.textContent).not.toContain('old-tail');
    expect(pageReads).toBe(2);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
