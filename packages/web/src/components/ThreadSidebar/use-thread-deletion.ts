import { useCallback, useRef, useState } from 'react';
import { useThreadDeletePreference } from '@/hooks/useThreadDeletePreference';
import {
  projectSidebarRows,
  type SidebarSnapshotRow,
  useSidebarProjectionStore,
} from '@/stores/sidebarProjectionStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell/shell-copy';
import { threadDeletionCopy } from './thread-deletion.shell-copy';

export function useThreadDeletion({
  currentThreadId,
  navigateToThread,
  loadThreads,
  showTrash,
  loadTrash,
}: {
  currentThreadId: string | null;
  navigateToThread: (id: string) => void;
  loadThreads: () => Promise<void>;
  showTrash: boolean;
  loadTrash: () => Promise<void>;
}) {
  const copy = useShellCopy(threadDeletionCopy);
  const preference = useThreadDeletePreference();
  const [deleteTarget, setDeleteTarget] = useState<SidebarSnapshotRow | null>(null);
  const pending = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const currentConversation = useRef(currentThreadId);
  currentConversation.current = currentThreadId;

  const performDelete = useCallback(
    (thread: SidebarSnapshotRow, remember = false) => {
      if (pending.current.has(thread.id)) return;
      pending.current.add(thread.id);
      setDeletingIds(new Set(pending.current));
      setDeleteTarget(null);
      const isSystem = thread.isHubThread || !!thread.systemKind;
      const url = `/api/threads/${thread.id}${isSystem ? '?force=true' : ''}`;
      void apiFetch(url, { method: 'DELETE' })
        .then(async (response) => {
          if (!response.ok) {
            const message = response.status === 409 ? copy.workingMessage : copy.failedMessage;
            useToastStore.getState().addToast({ type: 'error', title: copy.failedTitle, message, duration: 5000 });
            return;
          }
          const saved = !remember || isSystem || preference.setConfirmBeforeDelete(false);
          if (thread.id === currentConversation.current) navigateToThread('default');
          await loadThreads();
          if (showTrash) await loadTrash();
          useToastStore.getState().addToast({
            type: saved ? 'success' : 'info',
            title: copy.deletedTitle,
            message: saved ? copy.deletedMessage(thread.title ?? copy.unnamed) : copy.deletedPreferenceFailed,
            duration: 5000,
          });
        })
        .catch(() => {
          useToastStore
            .getState()
            .addToast({ type: 'error', title: copy.failedTitle, message: copy.uncertainMessage, duration: 5000 });
          void loadThreads();
        })
        .finally(() => {
          pending.current.delete(thread.id);
          setDeletingIds(new Set(pending.current));
        });
    },
    [copy, loadThreads, loadTrash, navigateToThread, preference.setConfirmBeforeDelete, showTrash],
  );

  const requestDelete = useCallback(
    (id: string) => {
      if (id === 'default' || pending.current.has(id)) return;
      const thread = projectSidebarRows(useSidebarProjectionStore.getState()).find((row) => row.id === id);
      if (!thread) return;
      if (thread.isHubThread || thread.systemKind || preference.confirmBeforeDelete) setDeleteTarget(thread);
      else performDelete(thread);
    },
    [performDelete, preference.confirmBeforeDelete],
  );
  const confirmDelete = useCallback(
    (remember: boolean) => {
      if (deleteTarget) performDelete(deleteTarget, remember);
    },
    [deleteTarget, performDelete],
  );
  const cancelDelete = useCallback(() => setDeleteTarget(null), []);
  return { deleteTarget, deletingIds, requestDelete, confirmDelete, cancelDelete, canRemember: preference.ready };
}
