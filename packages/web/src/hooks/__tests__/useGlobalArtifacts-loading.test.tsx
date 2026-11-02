import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn(() => new Promise<Response>(() => {})));

vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { useGlobalArtifacts } from '../useGlobalArtifacts';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
});

it('reports loading on the first enabled render instead of flashing a verified empty result', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: boolean[] = [];

  function Probe() {
    renders.push(useGlobalArtifacts(true).loading);
    return null;
  }

  act(() => root.render(<Probe />));
  expect(renders[0]).toBe(true);

  act(() => root.unmount());
  host.remove();
});

it('reports loading synchronously when an existing consumer becomes enabled', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: Array<{ enabled: boolean; loading: boolean }> = [];

  function Probe({ enabled }: { enabled: boolean }) {
    renders.push({ enabled, loading: useGlobalArtifacts(enabled).loading });
    return null;
  }

  act(() => root.render(<Probe enabled={false} />));
  const beforeEnable = renders.length;
  act(() => root.render(<Probe enabled />));
  expect(renders[beforeEnable]).toEqual({ enabled: true, loading: true });

  act(() => root.unmount());
  host.remove();
});

it('preserves a resolved work-lineage verdict from the global artifact response', async () => {
  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ artifacts: [], total: 0, workLineage: 'resolved' }),
  } as Response);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: Array<{ loading: boolean; workLineage: string }> = [];

  function Probe() {
    const result = useGlobalArtifacts(true);
    renders.push({ loading: result.loading, workLineage: result.workLineage });
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renders[renders.length - 1]).toEqual({ loading: false, workLineage: 'resolved' });
  act(() => root.unmount());
  host.remove();
});

it('requests the bounded recent-works view and exposes an incomplete read', async () => {
  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ artifacts: [], total: 0, workLineage: 'resolved', complete: false }),
  } as Response);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: Array<{ loading: boolean; complete: boolean }> = [];

  function Probe() {
    const result = useGlobalArtifacts(true, { view: 'recent-works', limit: 3 });
    renders.push({ loading: result.loading, complete: result.complete });
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(apiFetch).toHaveBeenCalledWith('/api/artifacts?view=recent-works&limit=3', expect.any(Object), {
    afterCurrentGet: true,
  });
  expect(renders[renders.length - 1]).toEqual({ loading: false, complete: false });
  act(() => root.unmount());
  host.remove();
});

it('does not manufacture a complete bounded read when the server omits the completeness flag', async () => {
  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ artifacts: [], total: 0, workLineage: 'resolved' }),
  } as Response);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: Array<{ loading: boolean; complete: boolean }> = [];

  function Probe() {
    const result = useGlobalArtifacts(true, { view: 'recent-works', limit: 3 });
    renders.push({ loading: result.loading, complete: result.complete });
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renders[renders.length - 1]).toEqual({ loading: false, complete: false });
  act(() => root.unmount());
  host.remove();
});

it.each([
  ['missing', { artifacts: [], total: 0 }],
  ['invalid', { artifacts: [], total: 0, workLineage: 'partial' }],
])('fails closed to unavailable when workLineage is %s', async (_label, body) => {
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => body } as Response);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renders: Array<{ loading: boolean; workLineage: string }> = [];

  function Probe() {
    const result = useGlobalArtifacts(true);
    renders.push({ loading: result.loading, workLineage: result.workLineage });
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renders[renders.length - 1]).toEqual({ loading: false, workLineage: 'unavailable' });
  act(() => root.unmount());
  host.remove();
});
