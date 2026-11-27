import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

type TitlePatchResult = { title?: string | null } | void;
type TitlePatch = (threadId: string, title: string) => Promise<TitlePatchResult>;

const pendingTitles = new Map<string, { confirmed: string; needsSnapshot: boolean; tail: Promise<void> }>();

/** Show a rename immediately and settle on the last title actually accepted by the server. */
export async function renameThreadTitleOptimistic(threadId: string, title: string, patch: TitlePatch): Promise<void> {
  const sidebar = useSidebarProjectionStore.getState();
  let pending = pendingTitles.get(threadId);
  if (!pending) {
    const confirmed = useChatStore.getState().threads.find((thread) => thread.id === threadId)?.title ?? '';
    const needsSnapshot = Object.values(sidebar.pendingThreadCommands).some(
      (command) => command.threadId === threadId && command.field === 'title' && command.confirmed,
    );
    pending = { confirmed, needsSnapshot, tail: Promise.resolve() };
    pendingTitles.set(threadId, pending);
  }
  const sequence = pending;
  const commandId = sidebar.beginSidebarCommand(threadId, 'title', title);
  useChatStore.getState().updateThreadTitle(threadId, title);
  const write = sequence.tail.then(async () => {
    const updated = await patch(threadId, title);
    sequence.confirmed = updated?.title ?? title;
    sequence.needsSnapshot = true;
  });
  const tail = write.catch(() => {});
  sequence.tail = tail;
  try {
    await write;
  } finally {
    if (sequence.tail === tail) {
      pendingTitles.delete(threadId);
      useChatStore.getState().updateThreadTitle(threadId, sequence.confirmed);
      const projection = useSidebarProjectionStore.getState();
      const canonicalTitle = projection.rows.find((row) => row.id === threadId)?.title;
      if (sequence.needsSnapshot && (projection.refreshing || canonicalTitle !== sequence.confirmed)) {
        // Keep the receipt visible until a read started after the PATCH can reconcile it.
        projection.beginSidebarCommand(threadId, 'title', sequence.confirmed, true);
        void invalidateSidebarProjection();
      } else {
        projection.failSidebarCommand(commandId);
      }
    }
  }
}
