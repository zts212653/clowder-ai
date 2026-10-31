import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
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
