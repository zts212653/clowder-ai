import { type Thread, useChatStore } from '@/stores/chatStore';
import { parseSidebarSnapshotRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { getApiGetGeneration } from '@/utils/api-get-generation';
import { loadSidebarSnapshot } from '@/utils/offline-store';
import { __resetSidebarProjectionObservabilityForTests } from '@/utils/sidebar-projection-observability';

type SidebarThread = Thread & {
  unreadCount?: number;
  hasUserMention?: boolean;
};

let activeRefreshCallers = 0;
let sidebarSnapshotEtag: string | null = null;

function isUnchangedSnapshot(response: Response, responseEtag: string | null): boolean {
  if (response.status === 304) {
    if (responseEtag) sidebarSnapshotEtag = responseEtag;
    return true;
  }
  return Boolean(responseEtag && responseEtag === sidebarSnapshotEtag);
}

function hydrateLegacyThreadStore(threads: SidebarThread[]): void {
  // Sidebar reads only the narrow projection above. Keep the wider response
  // hydrated for legacy Chat-owned surfaces until their separate migration.
  const chatStore = useChatStore.getState();
  chatStore.setThreads(threads);
  // Keep a pending title in the live legacy view while the canonical snapshot is persisted unchanged.
  for (const command of Object.values(useSidebarProjectionStore.getState().pendingThreadCommands)) {
    if (command.field === 'title') chatStore.updateThreadTitle(command.threadId, command.value as string);
  }
  for (const thread of threads) {
    if ((thread.unreadCount ?? 0) > 0 || thread.hasUserMention) {
      chatStore.initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
    }
  }
  chatStore.setLoadingThreads(false);
}

async function applySidebarResponse(response: Response, responseEtag: string | null): Promise<boolean> {
  const payload = (await response.json()) as { threads?: SidebarThread[] };
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  const rows = parseSidebarSnapshotRows(threads);
  const generation = getApiGetGeneration(response);
  if (generation == null) return false;
  const applied = useSidebarProjectionStore.getState().applySidebarSnapshot(rows, generation);
  if (!applied) {
    // A peer consuming the same cloned physical response may have committed
    // this exact generation first. That caller still observed canonical truth.
    const observedByPeer = useSidebarProjectionStore.getState().appliedGeneration === generation;
    if (observedByPeer && responseEtag) sidebarSnapshotEtag = responseEtag;
    return observedByPeer;
  }
  if (responseEtag) sidebarSnapshotEtag = responseEtag;
  hydrateLegacyThreadStore(threads);
  return true;
}

async function fetchAndApplySidebarSnapshot(afterCurrentGet: boolean): Promise<boolean> {
  try {
    const receipts = Object.values(useSidebarProjectionStore.getState().pendingThreadCommands).filter(
      (command) => command.field === 'title' && command.confirmed,
    );
    const ifNoneMatch = sidebarSnapshotEtag;
    const response = await apiFetch('/api/threads?view=sidebar', undefined, {
      // A read begun before these PATCH receipts may still carry the previous title.
      afterCurrentGet: afterCurrentGet || receipts.length > 0,
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    });
    if (!response.ok && response.status !== 304) return false;
    const responseEtag = response.headers.get('etag');
    const observed =
      isUnchangedSnapshot(response, responseEtag) ||
      (response.ok && (await applySidebarResponse(response, responseEtag)));
    if (!observed) return false;
    if (receipts.length) {
      const projection = useSidebarProjectionStore.getState();
      const pendingIds = new Set(Object.values(projection.pendingThreadCommands).map((command) => command.id));
      for (const { id, threadId } of receipts) {
        if (!pendingIds.has(id)) continue;
        projection.failSidebarCommand(id);
        const row = projection.rows.find((thread) => thread.id === threadId);
        if (row) useChatStore.getState().updateThreadTitle(threadId, row.title ?? '');
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function runSidebarRefresh(afterCurrentGet: boolean): Promise<boolean> {
  activeRefreshCallers += 1;
  useSidebarProjectionStore.getState().setRefreshing(true);
  try {
    return await fetchAndApplySidebarSnapshot(afterCurrentGet);
  } finally {
    activeRefreshCallers -= 1;
    if (activeRefreshCallers === 0) useSidebarProjectionStore.getState().setRefreshing(false);
  }
}

/**
 * Replace the rebuildable Sidebar projection with the server's canonical snapshot.
 * The shared apiFetch exact-GET coordinator prevents concurrent mount/online/
 * reconnect callers from amplifying physical full-list reads.
 */
export async function refreshSidebarThreadSnapshot(): Promise<boolean> {
  return runSidebarRefresh(false);
}

/** Edge events carry no truth; they only dirty the canonical full-snapshot read. */
export function invalidateSidebarProjection(): Promise<boolean> {
  return runSidebarRefresh(true);
}

export async function bootstrapSidebarThreadSnapshot(): Promise<boolean> {
  try {
    const cached = await loadSidebarSnapshot();
    if (!cached) return false;
    return useSidebarProjectionStore.getState().applySidebarSnapshot(cached, 0, { source: 'cache' });
  } catch {
    return false;
  }
}

export function __resetSidebarRefreshForTests(): void {
  activeRefreshCallers = 0;
  sidebarSnapshotEtag = null;
  __resetSidebarProjectionObservabilityForTests();
}
