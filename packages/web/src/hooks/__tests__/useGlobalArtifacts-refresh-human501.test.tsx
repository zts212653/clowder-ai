import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';

const sourceChanged = (threadId?: string) =>
  act(async () => {
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', {
        detail: { threadId, reason: 'works_changed' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it('refreshes mounted recent Works on the existing owner source invalidation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ artifacts: [], complete: false, workLineage: 'resolved' }),
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    useGlobalArtifacts(true, { view: 'recent-works', limit: 12 });
    return null;
  }
  try {
    await act(async () => {
      root.render(<Probe />);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await sourceChanged();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('a global catalogue refreshes for another threads scoped work event', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ artifacts: [], complete: false, workLineage: 'resolved' }),
  });
  function Probe() {
    useGlobalArtifacts(true, { view: 'recent-works', limit: 12 }, 'host');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await sourceChanged('another');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('retains known cards after a temporary source failure but clears them after permission denial', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockReset();
  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ artifacts: [{ name: 'known original' }], complete: true, workLineage: 'resolved' }),
  });
  apiFetch.mockResolvedValueOnce({ ok: false, status: 503 });
  apiFetch.mockResolvedValueOnce({ ok: false, status: 403 });
  let names: string[] = [];
  let complete = true;
  function Probe() {
    const result = useGlobalArtifacts(true, { view: 'recent-works', limit: 12 }, 'owner');
    names = result.artifacts.map((item) => item.name);
    complete = result.complete;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(names).toEqual(['known original']);
    await sourceChanged();
    expect(names).toEqual(['known original']);
    expect(complete).toBe(false);
    await sourceChanged();
    expect(names).toEqual([]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
