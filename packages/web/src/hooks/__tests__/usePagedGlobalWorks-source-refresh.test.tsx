import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { useGlobalArtifacts } from '../useGlobalArtifacts';
import { GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS } from '../usePagedGlobalWorks';

// 2026-10-23/24 runtime log: ~1.0M global Works page reads in 38h. Every host-thread
// material change aborted the running walk and re-read the whole catalogue from page one.
const page = (nextCursor?: string) =>
  Response.json({
    view: 'works',
    artifacts: [],
    complete: !nextCursor,
    workLineage: 'resolved',
    ...(nextCursor ? { nextCursor } : {}),
  });
const sourceChanged = () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

let root: Root;
const Probe = () => {
  useGlobalArtifacts(true, { view: 'works' });
  return null;
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  setVisibility('visible');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('lets a running walk finish and coalesces repeated source changes into one later walk', async () => {
  let finishFirstPage: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishFirstPage = done;
      }),
  );
  await act(async () => root.render(<Probe />));
  const firstSignal: AbortSignal = fetch.mock.calls[0][1].signal;

  await act(async () => {
    sourceChanged();
    sourceChanged();
    sourceChanged();
  });
  expect(firstSignal.aborted).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);

  fetch.mockResolvedValueOnce(page('two')).mockResolvedValueOnce(page()).mockResolvedValue(page());
  await act(async () => finishFirstPage(page()));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS));
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/artifacts?view=works&read=pages',
    '/api/artifacts?view=works&read=pages',
    '/api/artifacts?view=works&read=pages&cursor=two',
  ]);

  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS * 4));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('defers a source refresh while the tab is hidden and runs it once when visible', async () => {
  fetch.mockResolvedValue(page());
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => setVisibility('hidden'));
  await act(async () => {
    sourceChanged();
    sourceChanged();
  });
  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS * 4));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => setVisibility('visible'));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(fetch).toHaveBeenCalledTimes(2);
});
