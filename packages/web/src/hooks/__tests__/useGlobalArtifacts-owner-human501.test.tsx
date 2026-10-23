import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';

it('cancels the old owner read before it can paint in the new owner scope', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolveOld: (response: unknown) => void = () => {};
  apiFetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ artifacts: [{ name: 'new owner' }], complete: true, workLineage: 'resolved' }),
  });
  let names: string[] = [];
  function Probe({ owner }: { owner: string }) {
    const read = useGlobalArtifacts(true, { view: 'recent-works', limit: 12 }, owner);
    names = read.artifacts.map((item) => item.name);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(<Probe owner="old" />);
    });
    await act(async () => {
      root.render(<Probe owner="new" />);
    });
    await act(async () => {
      resolveOld({
        ok: true,
        json: async () => ({ artifacts: [{ name: 'old owner' }], complete: true, workLineage: 'resolved' }),
      });
    });
    expect(names).toEqual(['new owner']);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
