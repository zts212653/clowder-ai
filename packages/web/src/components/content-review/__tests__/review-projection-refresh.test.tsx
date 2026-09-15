import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';

it('invalidation during an active owner read consumes a fresh generation, not the pre-invalidation response', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const reads: Array<(response: Response) => void> = [];
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/session')) return response({ userId: 'operator' });
      expect(url).toContain('/api/entrusted-work/needs-me');
      return new Promise<Response>((resolve) => reads.push(resolve));
    }),
  );
  let projection: ReturnType<typeof useEntrustedWorkProjection> | undefined;
  function Probe() {
    projection = useEntrustedWorkProjection('needs-me');
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Probe));
    });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
      reads[0]?.(response({ error: 'pre-invalidation snapshot' }, 503));
    });
    await vi.waitFor(() => expect(reads).toHaveLength(2), { timeout: 500 });
    await act(async () => {
      reads[1]?.(response({ ownerReads: [] }));
    });
    expect(projection?.loading).toBe(false);
    expect(projection?.error).toBe(false);
    expect(projection?.ownerReads).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
