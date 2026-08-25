import { type Thread, useChatStore } from '@/stores/chatStore';
import { parseSidebarSnapshotRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { getApiGetGeneration } from '@/utils/api-get-generation';
import { loadSidebarSnapshot } from '@/utils/offline-store';

type SidebarThread = Thread & {
  unreadCount?: number;
  hasUserMention?: boolean;
};

let activeRefreshCallers = 0;

async function fetchAndApplySidebarSnapshot(afterCurrentGet: boolean): Promise<boolean> {
  try {
    const response = await apiFetch('/api/threads?view=sidebar', undefined, { afterCurrentGet });
    if (!response.ok) return false;
    const payload = (await response.json()) as { threads?: SidebarThread[] };
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    const rows = parseSidebarSnapshotRows(threads);
    const generation = getApiGetGeneration(response);
    if (generation == null) return false;
    const applied = useSidebarProjectionStore.getState().applySidebarSnapshot(rows, generation);
    if (!applied) {
      // A peer consuming the same cloned physical response may have committed
      // this exact generation first. That caller still observed canonical truth.
      return useSidebarProjectionStore.getState().appliedGeneration === generation;
    }

    // Sidebar reads only the narrow projection above. Keep the wider response
    // hydrated for legacy Chat-owned surfaces until their separate migration.
    const chatStore = useChatStore.getState();
    chatStore.setThreads(threads);
    for (const thread of threads) {
      if ((thread.unreadCount ?? 0) > 0 || thread.hasUserMention) {
        chatStore.initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
      }
    }
    chatStore.setLoadingThreads(false);
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
}
