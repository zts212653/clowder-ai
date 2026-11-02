import type { ApprovalHistoryPageRequest } from '@cat-cafe/shared';
import { afterEach, expect, it, vi } from 'vitest';
import type { OwnedApprovalHistoryPage } from '../approval-history-page-source';
import { createHandledHistoryRead } from '../handled-history-read';
import type { SettledResultItem } from '../settled-results-source';

const resources: ReturnType<typeof createHandledHistoryRead>[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.dispose();
  vi.useRealTimers();
});
const row = (owner = 'owner', summary = 'A recognizable proposal'): SettledResultItem => ({
  proposalId: 'proposal',
  sourceFeatureId: 'F128',
  ownerUserId: owner,
  requesterCatId: 'codex61-sol',
  summary,
  detail: {},
  navigation: { state: 'legacy_unanchored' },
  createdAt: 1,
  decidedAt: 2,
  decidedBy: owner,
  resolution: 'accepted',
  materialization: { state: 'not_started' },
});
function page(items: SettledResultItem[], nextCursor: string | null = null): OwnedApprovalHistoryPage {
  return {
    items,
    count: items.length,
    identity: { ownerUserId: items[0]?.ownerUserId ?? 'owner' },
    manifest: [{ id: 'F128' }],
    page: { limit: 30, nextCursor, hasMore: nextCursor !== null },
    coverage: { state: 'complete', orderVersion: 1, sources: ['F128'] },
  };
}
function setup() {
  const requests: { resolve: (items: SettledResultItem[] | null | 'preparing') => void; signal: AbortSignal }[] = [];
  const load = vi.fn((_owner: string, signal: AbortSignal, _request: ApprovalHistoryPageRequest) => {
    void _request;
    return new Promise<OwnedApprovalHistoryPage | null | 'preparing'>((resolve) =>
      requests.push({ resolve: (result) => resolve(Array.isArray(result) ? page(result) : result), signal }),
    );
  });
  const read = createHandledHistoryRead(load);
  resources.push(read);
  read.setOwner('owner');
  return { read, requests, load };
}
it('does not read on the pending page; same-window opens share one request', async () => {
  const { read, requests, load } = setup();
  expect(load).not.toHaveBeenCalled();
  read.setActive(true);
  read.setActive(true);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0]).toEqual(['owner', expect.any(AbortSignal), { limit: 30 }]);
  requests[0].resolve([row()]);
  await Promise.resolve();
  expect(read.getSnapshot().status).toBe('ready');
});
it('keeps the last successful rows and read time through reopen, refresh and failure', async () => {
  const { read, requests } = setup();
  read.setActive(true);
  requests[0].resolve([row()]);
  await Promise.resolve();
  const before = read.getSnapshot();
  read.setActive(false);
  read.setActive(true);
  expect(read.getSnapshot()).toMatchObject({ items: before.items, observedAt: before.observedAt, status: 'reading' });
  requests[1].resolve(null);
  await Promise.resolve();
  expect(read.getSnapshot()).toMatchObject({
    items: before.items,
    observedAt: before.observedAt,
    status: 'unavailable',
  });
});
it('coalesces an event burst into one trailing read without accepting an old-owner response', async () => {
  vi.useFakeTimers();
  const { read, requests, load } = setup();
  read.setActive(true);
  read.invalidate();
  read.invalidate();
  read.invalidate();
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  requests[0].resolve([row()]);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  read.setOwner('other');
  expect(requests[1].signal.aborted).toBe(true);
  expect(read.getSnapshot().items).toBeNull();
  requests[1].resolve([row()]);
  requests[2].resolve([row('other')]);
  await Promise.resolve();
  expect(read.getSnapshot().items?.map((r) => r.ownerUserId)).toEqual(['other']);
});
it('continues only a preparing source automatically and leaves ordinary failures for explicit retry', async () => {
  vi.useFakeTimers();
  const { read, requests, load } = setup();
  read.setActive(true);
  requests[0].resolve('preparing');
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(2);
  requests[1].resolve(null);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  const retry = read.refresh();
  requests[2].resolve([]);
  await retry;
  expect(read.getSnapshot()).toMatchObject({ items: [], status: 'ready' });
});

it('uses a real cursor for continuation and excludes a late old page after a new head', async () => {
  let resolveMore!: (page: OwnedApprovalHistoryPage) => void;
  const load = vi.fn(async (_owner: string, _signal: AbortSignal, request: ApprovalHistoryPageRequest) =>
    request.cursor
      ? new Promise<OwnedApprovalHistoryPage>((resolve) => {
          resolveMore = resolve;
        })
      : page([row()], 'cursor-30'),
  );
  const read = createHandledHistoryRead(load);
  resources.push(read);
  read.setOwner('owner');
  read.setActive(true);
  await Promise.resolve();
  await Promise.resolve();
  const more = read.loadMore();
  await Promise.resolve();
  expect(load.mock.calls[1][2]).toEqual({ limit: 30, cursor: 'cursor-30' });
  const refresh = read.refresh();
  await refresh;
  resolveMore(page([{ ...row(), proposalId: 'late-old-page' }]));
  await more;
  expect(read.getSnapshot().items?.map((item) => item.proposalId)).toEqual(['proposal']);
});
it('new head and older cached rows coexist, but only current-generation keys may authorize navigation', async () => {
  const first = page([row()], 'cursor-30');
  let revision = 0;
  const load = vi.fn(async () =>
    revision++ === 0 ? first : page([{ ...row(), proposalId: 'new', decidedAt: 3 }], 'new-cursor'),
  );
  const read = createHandledHistoryRead(load);
  resources.push(read);
  read.setOwner('owner');
  read.setActive(true);
  await Promise.resolve();
  await Promise.resolve();
  await read.refresh();
  expect(read.getSnapshot().items?.map((item) => item.proposalId)).toEqual(['new', 'proposal']);
  expect(read.getSnapshot().currentKeys.size).toBe(1);
});
