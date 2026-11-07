import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { useGlobalArtifacts } from '../useGlobalArtifacts';

const page = (nextCursor?: string) =>
  Response.json({
    view: 'works',
    artifacts: [],
    complete: !nextCursor,
    workLineage: 'resolved',
    nextCursor,
  });
const changed = (reason?: string) =>
  window.dispatchEvent(new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { reason } }));
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof useGlobalArtifacts>;
function Probe({ paused = false, recent = false }) {
  result = useGlobalArtifacts(true, recent ? { view: 'recent-works', limit: 12 } : { view: 'works' }, undefined, {
    paused,
  });
  return null;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  observeApiSessionOwner(null);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('does not rescan or replace a committed cursor after ordinary broad Task activity', async () => {
  fetch.mockResolvedValueOnce(page('retained'));
  await act(async () => root.render(<Probe />));
  await act(async () => {
    changed();
    changed();
    changed();
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.hasMore).toBe(true);
  fetch.mockResolvedValueOnce(page());
  await act(async () => result.loadMore?.());
  expect(fetch.mock.calls[1][0]).toContain('cursor=retained');
});

it('marks material changes without aborting or automatically continuing an admitted read', async () => {
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<Probe />));
  const signal: AbortSignal = fetch.mock.calls[0][1].signal;
  await act(async () => {
    changed('works_changed');
    changed('works_changed');
  });
  expect(signal.aborted).toBe(false);
  await act(async () => finish(page('next')));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.stale).toBe(true);
  expect(result.hasMore).toBe(true);
});

it('coalesces confirmed material publications into one recent refresh and ignores broad activity', async () => {
  fetch.mockResolvedValue(page());
  await act(async () => root.render(<Probe recent />));
  await act(async () => {
    changed();
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    changed('works_changed');
    changed('works_changed');
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toContain('view=recent-works');
});

it('discards an unscoped revoked snapshot while hidden and fences its late response', async () => {
  fetch.mockResolvedValueOnce(page('old'));
  await act(async () => root.render(<Probe />));
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => result.loadMore?.());
  await act(async () => root.render(<Probe paused />));
  await act(async () => {
    changed('access_revoked');
    finish(page());
  });
  expect(result.hasMore).toBe(false);
  expect(result.error).toBe(true);
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(page());
  await act(async () => result.refetch());
  expect(fetch.mock.calls[2][0]).not.toContain('cursor=');
});

it('abandons the old cursor and late continuation when the authenticated session owner changes', async () => {
  observeApiSessionOwner('first-owner');
  fetch.mockResolvedValueOnce(page('old-owner-cursor'));
  await act(async () => root.render(<Probe />));
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => result.loadMore?.());
  const signal: AbortSignal = fetch.mock.calls[1][1].signal;
  fetch.mockResolvedValueOnce(page());
  await act(async () => observeApiSessionOwner('second-owner'));
  expect(signal.aborted).toBe(true);
  expect(fetch.mock.calls[2][0]).not.toContain('cursor=');
  await act(async () => finish(page('late-old-owner-cursor')));
  expect(result.hasMore).toBe(false);
  expect(result.complete).toBe(true);
});
