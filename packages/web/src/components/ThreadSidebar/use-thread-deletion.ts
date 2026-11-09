import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import {
  projectSidebarRows,
  type SidebarSnapshotRow,
  useSidebarProjectionStore,
} from '@/stores/sidebarProjectionStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { useShellCopy } from '../shell/shell-copy';
import { threadDeletionCopy } from './thread-deletion.shell-copy';

export function useThreadDeletion({
  currentThreadId,
  navigateToThread,
  showTrash,
  loadTrash,
}: {
  currentThreadId: string | null;
  navigateToThread: (id: string) => void;
  showTrash: boolean;
  loadTrash: (afterCurrentGet?: boolean) => Promise<void>;
}) {
  const copy = useShellCopy(threadDeletionCopy);
  const identity = useSyncExternalStore(apiSessionIdentity.subscribe, apiSessionIdentity.getSnapshot, () => null);
  const [deleteDraft, setDeleteDraft] = useState<{
    thread: SidebarSnapshotRow;
    identity: typeof identity;
  } | null>(null);
  // Identity generations also invalidate drafts after an A → B → A change.
  const deleteTarget = deleteDraft?.identity === identity ? deleteDraft.thread : null;
  const pending = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const currentConversation = useRef(currentThreadId);
  currentConversation.current = currentThreadId;

  const performDelete = useCallback(
    (thread: SidebarSnapshotRow) => {
      if (identity !== apiSessionIdentity.getSnapshot() || pending.current.has(thread.id)) return;
      pending.current.add(thread.id);
      setDeletingIds(new Set(pending.current));
      setDeleteDraft(null);
      const controller = new AbortController();
      const unsubscribeIdentity = apiSessionIdentity.subscribe(() => {
        if (identity !== apiSessionIdentity.getSnapshot()) controller.abort();
      });
      const isSystem = thread.isHubThread || !!thread.systemKind;
      const url = `/api/threads/${thread.id}${isSystem ? '?force=true' : ''}`;
      void apiFetch(url, { method: 'DELETE', signal: controller.signal })
        .then(async (response) => {
          if (controller.signal.aborted) return;
          if (!response.ok) {
            const message = response.status === 409 ? copy.workingMessage : copy.failedMessage;
            useToastStore.getState().addToast({ type: 'error', title: copy.failedTitle, message, duration: 5000 });
            return;
          }
          if (thread.id === currentConversation.current) navigateToThread('default');
          await invalidateSidebarProjection();
          if (controller.signal.aborted) return;
          if (showTrash) await loadTrash(true);
          if (controller.signal.aborted) return;
          useToastStore.getState().addToast({
            type: 'success',
            title: copy.deletedTitle,
            message: copy.deletedMessage(thread.title ?? copy.unnamed),
            duration: 5000,
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          useToastStore
            .getState()
            .addToast({ type: 'error', title: copy.failedTitle, message: copy.uncertainMessage, duration: 5000 });
          void invalidateSidebarProjection();
        })
        .finally(() => {
          unsubscribeIdentity();
          pending.current.delete(thread.id);
          setDeletingIds(new Set(pending.current));
        });
    },
    [copy, loadTrash, navigateToThread, identity, showTrash],
  );

  const requestDelete = useCallback(
    (id: string) => {
      if (id === 'default' || pending.current.has(id)) return;
      const thread = projectSidebarRows(useSidebarProjectionStore.getState()).find((row) => row.id === id);
      if (!thread) return;
      setDeleteDraft({ thread, identity });
    },
    [identity],
  );
  const confirmDelete = useCallback(() => {
    if (deleteTarget) performDelete(deleteTarget);
  }, [deleteTarget, performDelete]);
  const cancelDelete = useCallback(() => setDeleteDraft(null), []);
  return { deleteTarget, deletingIds, requestDelete, confirmDelete, cancelDelete };
}
