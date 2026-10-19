import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { useGlobalArtifacts } from '../useGlobalArtifacts';

const artifact = (name: string): GlobalArtifactDTO => ({
  type: 'image',
  name,
  catId: 'codex61-sol',
  threadId: 'T',
  threadTitle: 'Thread',
  createdAt: 1,
  sourceMessageId: name,
  url: `/uploads/${name}.png`,
  publicationItem: { kind: 'content-block', index: 0 },
});
const page = (artifacts: GlobalArtifactDTO[], nextCursor?: string, workLineage = 'resolved') =>
  Response.json({
    view: 'works',
    artifacts,
    complete: !nextCursor,
    workLineage,
    ...(nextCursor ? { nextCursor } : {}),
  });
let host: HTMLDivElement;
let root: Root;
let result: ReturnType<typeof useGlobalArtifacts>;
const Probe = ({ enabled = true }) => {
  result = useGlobalArtifacts(enabled, { view: 'works' });
  return null;
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('publishes a useful first batch while a later request waits; retry preserves it and resumes the failed cursor', async () => {
  let reject: (error: Error) => void = () => {};
  fetch.mockResolvedValueOnce(page([artifact('one')], 'page-two')).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await act(async () => root.render(<Probe />));
  expect(result.artifacts.map((item) => item.name)).toEqual(['one']);
  expect(result.loading).toBe(false);
  expect(result.loadingMore).toBe(true);
  expect(result.complete).toBe(false);
  expect(fetch.mock.calls[1][0]).toBe('/api/artifacts?view=works&read=pages&cursor=page-two');
  await act(async () => reject(new Error('temporary source failure')));
  expect(result.error).toBe(true);
  expect(result.artifacts).toHaveLength(1);
  fetch.mockResolvedValueOnce(page([artifact('two')]));
  await act(async () => result.refetch());
  expect(fetch.mock.calls[2][0]).toContain('cursor=page-two');
  expect(result.artifacts.map((item) => item.name)).toEqual(['one', 'two']);
  expect(result.complete).toBe(true);
});

it('does not let a late, aborted response populate a new catalogue', async () => {
  let resolve: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(<Probe enabled={false} />));
  fetch.mockResolvedValueOnce(page([artifact('current')]));
  await act(async () => root.render(<Probe />));
  await act(async () => resolve(page([artifact('stale')])));
  expect(result.artifacts.map((item) => item.name)).toEqual(['current']);
});

it('removes partial lineage across every loaded row and rejects a repeated continuation', async () => {
  fetch
    .mockResolvedValueOnce(
      page([{ ...artifact('one'), work: { contentRef: 'C', ownerRevision: 1, currentOwnerRevision: 2 } }], 'two'),
    )
    .mockResolvedValueOnce(page([artifact('two')], 'three', 'unavailable'))
    .mockResolvedValueOnce(page([], 'three'));
  await act(async () => root.render(<Probe />));
  expect(result.error).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.workLineage).toBe('unavailable');
  expect(result.artifacts.every((item) => !item.work)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('retains equally named widgets without inventing an original-item identity', async () => {
  const item = { ...artifact('Same widget title'), type: 'widget' as const };
  delete item.publicationItem;
  delete item.url;
  fetch.mockResolvedValueOnce(page([item, { ...item }]));
  await act(async () => root.render(<Probe />));
  expect(result.artifacts).toHaveLength(2);
});

it('keeps unlocated images distinct even when their URLs match', async () => {
  const item = { ...artifact('Unlocated image'), sourceMessageId: null };
  delete item.publicationItem;
  fetch.mockResolvedValueOnce(page([item, { ...item }]));
  await act(async () => root.render(<Probe />));
  expect(result.artifacts).toHaveLength(2);
});

it('keeps the complete catalogue while a same-scope refresh drains its replacement pages', async () => {
  fetch.mockResolvedValueOnce(page([artifact('old')]));
  await act(async () => root.render(<Probe />));
  let resolve: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => result.refetch());
  expect(result.complete).toBe(true);
  expect(result.artifacts.map((item) => item.name)).toEqual(['old']);
  await act(async () => resolve(page([artifact('replacement')])));
  expect(result.artifacts.map((item) => item.name)).toEqual(['replacement']);
});

it('does not resurrect a withdrawn catalogue when retrying a failed refresh', async () => {
  fetch.mockResolvedValueOnce(page([artifact('old')]));
  await act(async () => root.render(<Probe />));
  fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
  await act(async () => result.refetch());
  expect(result.error).toBe(true);
  fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
  await act(async () => result.refetch());
  expect(result.complete).toBe(false);
  expect(result.loading).toBe(true);
});
