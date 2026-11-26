import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

type TitlePatchResult = { title?: string | null } | void;
type TitlePatch = (threadId: string, title: string) => Promise<TitlePatchResult>;

const pendingTitles = new Map<string, { confirmed: string; tail: Promise<void> }>();

/** Show a rename immediately and settle on the last title actually accepted by the server. */
export async function renameThreadTitleOptimistic(threadId: string, title: string, patch: TitlePatch): Promise<void> {
  let pending = pendingTitles.get(threadId);
  if (!pending) {
    const confirmed = useChatStore.getState().threads.find((thread) => thread.id === threadId)?.title ?? '';
    pending = { confirmed, tail: Promise.resolve() };
    pendingTitles.set(threadId, pending);
  }
  const sequence = pending;
  const sidebar = useSidebarProjectionStore.getState();
  const commandId = sidebar.beginSidebarCommand(threadId, 'title', title);
  useChatStore.getState().updateThreadTitle(threadId, title);
  const write = sequence.tail.then(async () => {
    const updated = await patch(threadId, title);
    sequence.confirmed = updated?.title ?? title;
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
      if (projection.refreshing) {
        // A sidebar read already in flight may carry the old title. Keep the receipt visible through its trailing read.
        const confirmedCommand = projection.beginSidebarCommand(threadId, 'title', sequence.confirmed);
        void invalidateSidebarProjection().finally(() => projection.failSidebarCommand(confirmedCommand));
      } else {
        projection.failSidebarCommand(commandId);
      }
    }
  }
}
