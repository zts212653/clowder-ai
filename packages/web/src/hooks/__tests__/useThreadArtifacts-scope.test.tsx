import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ apiFetch: vi.fn(), messages: [] }));
vi.mock('@/utils/api-client', () => ({ apiFetch: data.apiFetch }));
vi.mock('../useThreadScopedSelectors', () => ({
  useThreadMessages: () => data.messages,
  useThreadLiveness: () => ({ hasActive: false }),
}));

import { useThreadArtifacts } from '../useThreadArtifacts';

it('never exposes the previous scope total, including the render before the new effect starts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const renders: Array<{ id: string; total: number | null }> = [];
  data.apiFetch.mockResolvedValue(
    Response.json({ artifacts: [], total: 4, complete: true, workLineage: 'resolved', view: 'works' }),
  );
  function Reader({ id }: { id: string }) {
    const result = useThreadArtifacts(id, 'works');
    renders.push({ id, total: result.total });
    return null;
  }
  try {
    await act(async () => root.render(<Reader id="a" />));
    expect(renders.at(-1)).toEqual({ id: 'a', total: 4 });
    data.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => root.render(<Reader id="b" />));
    expect(renders.filter((render) => render.id === 'b').every((render) => render.total === null)).toBe(true);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('withdraws coverage on failure and does not revive it while a retry is pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data.apiFetch.mockReset();
  data.apiFetch.mockResolvedValue(
    Response.json({ artifacts: [], total: 4, complete: true, workLineage: 'resolved', view: 'works' }),
  );
  const root = createRoot(document.createElement('div'));
  let latest: ReturnType<typeof useThreadArtifacts>;
  function Reader() {
    latest = useThreadArtifacts('a', 'works');
    return null;
  }
  try {
    await act(async () => root.render(<Reader />));
    expect(latest!.total).toBe(4);
    data.apiFetch.mockResolvedValue(new Response('', { status: 503 }));
    await act(async () => {
      void latest!.refetch();
    });
    expect(latest!.error).toBe(true);
    data.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => {
      void latest!.refetch();
    });
    expect(latest!.loading).toBe(true);
    expect(latest!.total).toBeNull();
    expect(latest!.complete).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
