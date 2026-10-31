import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMemoryRead } from '../use-memory-read';
import { useMemoryRecall } from '../use-memory-recall';
import { deferred, page, type Reply, recallRow, response } from './recall-page-fixture';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
type Snapshot = { label: string; data: string | null; loading: boolean; error: boolean };
let container: HTMLDivElement;
let root: Root;
let snapshots: Snapshot[];

function ReadProbe({ path }: { path: string }) {
  const read = useMemoryRead<{ value: string }>(path);
  useLayoutEffect(() => {
    snapshots.push({ label: path, data: read.data?.value ?? null, loading: read.loading, error: read.error });
  });
  return (
    <button type="button" onClick={read.retry}>
      Retry
    </button>
  );
}
function RecallProbe({ source, catId = '' }: { source: string; catId?: string }) {
  const read = useMemoryRecall(7, source, catId);
  useLayoutEffect(() => {
    snapshots.push({
      label: `${source}:${catId}`,
      data: read.data?.records[0]?.event.query ?? null,
      loading: read.loading,
      error: read.error,
    });
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  snapshots = [];
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it('hides previous data in every committed frame of a new read path', async () => {
  mocks.fetch.mockResolvedValue(response({ value: 'old-window' }));
  await act(async () => root.render(<ReadProbe path="/stats?days=14" />));
  expect(snapshots.at(-1)?.data).toBe('old-window');
  const pending = deferred<Reply>();
  mocks.fetch.mockReturnValue(pending.promise);
  snapshots = [];
  await act(async () => root.render(<ReadProbe path="/stats?days=30" />));
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((frame) => frame.data === null && frame.loading && !frame.error)).toBe(true);
  await act(async () => pending.resolve(response({ value: 'new-window' })));
  expect(snapshots.at(-1)?.data).toBe('new-window');
});
it('hides previous data in every committed frame of a retry', async () => {
  mocks.fetch.mockResolvedValue(response({ value: 'old-revision' }));
  await act(async () => root.render(<ReadProbe path="/detail" />));
  const pending = deferred<Reply>();
  mocks.fetch.mockReturnValue(pending.promise);
  snapshots = [];
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((frame) => frame.data === null && frame.loading)).toBe(true);
});
it('hides the previous recall filter in every committed frame of a new source and cat', async () => {
  mocks.fetch.mockResolvedValue(response(page({ records: [recallRow('old', 'old-filter')] })));
  await act(async () => root.render(<RecallProbe source="all" />));
  expect(snapshots.at(-1)?.data).toBe('old-filter');
  mocks.fetch.mockReturnValue(deferred<Reply>().promise);
  snapshots = [];
  await act(async () => root.render(<RecallProbe source="pull" catId="sonnet" />));
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((frame) => frame.data === null && frame.loading && !frame.error)).toBe(true);
});
it('rejects a late response from an earlier generic read', async () => {
  const old = deferred<Reply>();
  mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response({ value: 'new-window' }));
  await act(async () => root.render(<ReadProbe path="/stats?days=14" />));
  await act(async () => root.render(<ReadProbe path="/stats?days=30" />));
  await act(async () => old.resolve(response({ value: 'old-window' })));
  expect(snapshots.at(-1)).toEqual({ label: '/stats?days=30', data: 'new-window', loading: false, error: false });
});
