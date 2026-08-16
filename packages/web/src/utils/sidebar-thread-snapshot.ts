import { type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type SidebarThread = Thread & {
  unreadCount?: number;
  hasUserMention?: boolean;
};

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Replace the rebuildable Sidebar projection with the server's canonical snapshot.
 * Concurrent mount/online/reconnect callers share one request so reconnect jitter
 * cannot amplify full-list reads.
 */
export async function refreshSidebarThreadSnapshot(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const refresh = (async () => {
    try {
      const response = await apiFetch('/api/threads?view=sidebar');
      if (!response.ok) return false;

      const payload = (await response.json()) as { threads?: SidebarThread[] };
      const threads = Array.isArray(payload.threads) ? payload.threads : [];
      const store = useChatStore.getState();
      store.setThreads(threads);
      for (const thread of threads) {
        if ((thread.unreadCount ?? 0) > 0 || thread.hasUserMention) {
          store.initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
        }
      }
      return true;
    } catch {
      return false;
    }
  })();

  refreshInFlight = refresh;
  try {
    return await refresh;
  } finally {
    if (refreshInFlight === refresh) refreshInFlight = null;
  }
}
