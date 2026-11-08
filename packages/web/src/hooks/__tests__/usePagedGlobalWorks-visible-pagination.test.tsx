import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { usePagedGlobalWorks } from '../usePagedGlobalWorks';

const artifact = (id: number): GlobalArtifactDTO => ({
  type: 'file',
  name: `Work ${id}`,
  catId: null,
  createdAt: id,
  threadId: 'T',
  threadTitle: 'Thread',
  sourceMessageId: `M${id}`,
  url: `/uploads/${id}.pdf`,
  publicationItem: { kind: 'content-block', index: 0 },
});
const page = (artifacts: GlobalArtifactDTO[] = [], nextCursor?: string, workLineage = 'resolved') =>
  Response.json({ view: 'works', artifacts, complete: !nextCursor, workLineage, nextCursor });
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof usePagedGlobalWorks>;
function Probe({ paused = false, owner = 'owner' }) {
  result = usePagedGlobalWorks(true, owner, paused);
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('reaches a sparse ninth page by explicit 1+4+4 batches and keeps empty continuations reachable', async () => {
  Array.from({ length: 8 }, (_, i) => fetch.mockResolvedValueOnce(page([], `p${i + 2}`)));
  fetch.mockResolvedValueOnce(page(Array.from({ length: 16 }, (_, i) => artifact(i))));
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.hasMore).toBe(true);
  expect(result.loading).toBe(false);
  await act(async () => result.loadMore());
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(result.hasMore).toBe(true);
  expect(result.artifacts).toEqual([]);
  await act(async () => result.loadMore());
  expect(fetch).toHaveBeenCalledTimes(9);
  expect(result.artifacts).toHaveLength(16);
  expect(result.complete).toBe(true);
  expect(result.hasMore).toBe(false);
});

it('coalesces clicks, stops after 24 new displayable works and retains the whole last page', async () => {
  let finish: (value: Response) => void = () => {};
  fetch.mockResolvedValueOnce(page([artifact(0)], 'second')).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    result.loadMore();
    result.loadMore();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () =>
    finish(
      page(
        Array.from({ length: 40 }, (_, i) => artifact(i + 1)),
        'third',
      ),
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.artifacts).toHaveLength(41);
  expect(result.loadingMore).toBe(false);
  expect(result.hasMore).toBe(true);
});

it('keeps the committed cursor through hide, retry and a failed refresh; refresh success replaces it', async () => {
  fetch.mockResolvedValueOnce(page([artifact(0)], 'old-cursor'));
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(1);
  let finish: (value: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => result.loadMore());
  const signal: AbortSignal = fetch.mock.calls[1][1].signal;
  await act(async () => root.render(<Probe paused />));
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(page([artifact(99)]));
  });
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.artifacts.map((item) => item.name)).toEqual(['Work 0']);
  fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
  await act(async () => result.restart());
  expect(result.error).toBe(true);
  expect(result.artifacts).toHaveLength(1);
  fetch
    .mockResolvedValueOnce(page([artifact(1)], 'retry-after-this'))
    .mockResolvedValueOnce(new Response('', { status: 503 }));
  await act(async () => result.loadMore());
  expect(fetch.mock.calls[3][0]).toContain('cursor=old-cursor');
  expect(fetch.mock.calls[4][0]).toContain('cursor=retry-after-this');
  fetch.mockResolvedValueOnce(page([artifact(10)], 'fresh-cursor'));
  await act(async () => result.restart());
  expect(fetch.mock.calls[5][0]).not.toContain('cursor=');
  expect(result.artifacts.map((item) => item.name)).toEqual(['Work 10']);
  fetch.mockResolvedValueOnce(page());
  await act(async () => result.loadMore());
  expect(fetch.mock.calls[6][0]).toContain('cursor=fresh-cursor');
});

it.each([400, 409, 401, 403])('discards the snapshot and cursor on continuation status %i', async (status) => {
  fetch.mockResolvedValueOnce(page([artifact(0)], 'old'));
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(new Response('', { status }));
  await act(async () => result.loadMore());
  expect(result.artifacts).toEqual([]);
  expect(result.hasMore).toBe(false);
  fetch.mockResolvedValueOnce(page([artifact(2)]));
  await act(async () => result.refetch());
  expect(fetch.mock.calls[2][0]).not.toContain('cursor=');
});

it('retries a failed explicit refresh from page one without mixing the retained cursor', async () => {
  fetch.mockResolvedValueOnce(page([artifact(0)], 'retained-cursor'));
  await act(async () => root.render(<Probe />));
  fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
  await act(async () => result.restart());
  expect(result.artifacts.map((item) => item.name)).toEqual(['Work 0']);
  fetch.mockResolvedValueOnce(page([artifact(10)], 'fresh-cursor'));
  await act(async () => result.refetch());
  expect(fetch.mock.calls[2][0]).not.toContain('cursor=');
  expect(result.artifacts.map((item) => item.name)).toEqual(['Work 10']);
});
