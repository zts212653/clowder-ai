import { type ApprovalHistoryPageRequest, compareApprovalHistoryItems } from '@cat-cafe/shared';
import { type OwnedApprovalHistoryPage, readApprovalHistoryPage } from './approval-history-page-source';
import { SettledOwnerUnverified, type SettledResultItem, settledResultKey } from './settled-results-source';

export interface HandledHistorySnapshot {
  owner: string | null;
  items: SettledResultItem[] | null;
  status: 'idle' | 'reading' | 'ready' | 'preparing' | 'unavailable';
  observedAt: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  currentKeys: ReadonlySet<string>;
}
type Loader = (
  owner: string,
  signal: AbortSignal,
  request: ApprovalHistoryPageRequest,
) => Promise<OwnedApprovalHistoryPage | null | 'preparing'>;
const initial = (owner: string | null): HandledHistorySnapshot => ({
  owner,
  items: null,
  status: 'idle',
  observedAt: null,
  nextCursor: null,
  hasMore: false,
  loadingMore: false,
  moreFailed: false,
  currentKeys: new Set(),
});
const sort = compareApprovalHistoryItems;

/** One ephemeral owner window, with true server continuations. Cached rows never confer action permission. */
export function createHandledHistoryRead(load: Loader = readApprovalHistoryPage) {
  let snapshot = initial(null),
    active = false,
    controller: AbortController | null = null,
    pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null,
    invalidated = false,
    eventQueued = false;
  const listeners = new Set<() => void>();
  const publish = (value: HandledHistorySnapshot) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const request = (more = false, replace = false): Promise<void> => {
    if (!active || !snapshot.owner || (more && !snapshot.hasMore)) return Promise.resolve();
    if (pending && !replace) return pending;
    stopTimer();
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const owner = snapshot.owner,
      cursor = more ? snapshot.nextCursor : null;
    invalidated = false;
    publish({
      ...snapshot,
      ...(more
        ? { loadingMore: true, moreFailed: false }
        : {
            status: snapshot.status === 'preparing' ? 'preparing' : 'reading',
            loadingMore: false,
            moreFailed: false,
            currentKeys: new Set<string>(),
          }),
    });
    const task = (async () => {
      try {
        const result = await load(owner, current.signal, { limit: 30, ...(cursor ? { cursor } : {}) });
        if (current.signal.aborted || snapshot.owner !== owner) return;
        if (result === 'preparing') {
          publish({ ...snapshot, status: 'preparing', loadingMore: false });
          return;
        }
        if (result === null) {
          publish({ ...snapshot, ...(more ? { loadingMore: false, moreFailed: true } : { status: 'unavailable' }) });
          return;
        }
        const currentKeys = new Set(more ? snapshot.currentKeys : []);
        const previous = new Map(snapshot.items?.map((item) => [settledResultKey(item), item]));
        for (const item of result.items) {
          const key = settledResultKey(item),
            before = previous.get(key);
          currentKeys.add(key);
          previous.set(key, before && JSON.stringify(before) === JSON.stringify(item) ? before : item);
        }
        // A new head can be shown alongside older cached pages; only this generation's keys enable navigation.
        const items = [...previous.values()]
          .filter((item) => result.page.hasMore || currentKeys.has(settledResultKey(item)))
          .sort(sort);
        publish({
          owner,
          items,
          status: 'ready',
          observedAt: Date.now(),
          nextCursor: result.page.nextCursor,
          hasMore: result.page.hasMore,
          loadingMore: false,
          moreFailed: false,
          currentKeys,
        });
      } catch (error) {
        if (!current.signal.aborted && snapshot.owner === owner)
          publish(
            error instanceof SettledOwnerUnverified
              ? { ...initial(owner), status: 'unavailable' }
              : { ...snapshot, ...(more ? { loadingMore: false, moreFailed: true } : { status: 'unavailable' }) },
          );
      } finally {
        if (controller === current) {
          pending = null;
          if (active && (invalidated || snapshot.status === 'preparing'))
            timer = setTimeout(() => void request(), invalidated ? 0 : 1000);
        }
      }
    })();
    pending = task;
    return task;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOwner(owner: string | null) {
      if (snapshot.owner === owner) return;
      controller?.abort();
      controller = null;
      pending = null;
      stopTimer();
      invalidated = false;
      publish(initial(owner));
      if (active) void request();
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      if (active) void request();
      else stopTimer();
    },
    refresh: () => request(false, true),
    loadMore: () => request(true),
    invalidate() {
      invalidated = true;
      if (eventQueued) return;
      eventQueued = true;
      queueMicrotask(() => {
        eventQueued = false;
        if (active && invalidated && !pending) void request();
      });
    },
    dispose() {
      active = false;
      controller?.abort();
      stopTimer();
      listeners.clear();
    },
  };
}
export type HandledHistoryRead = ReturnType<typeof createHandledHistoryRead>;
