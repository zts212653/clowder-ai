import { useCallback, useRef, useState } from 'react';
import { useThreadDeletePreference } from '@/hooks/useThreadDeletePreference';
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
  const preference = useThreadDeletePreference();
  const [deleteDraft, setDeleteDraft] = useState<{
    thread: SidebarSnapshotRow;
    identity: typeof preference.identity;
  } | null>(null);
  // Identity generations also invalidate drafts after an A → B → A change.
  const deleteTarget = deleteDraft?.identity === preference.identity ? deleteDraft.thread : null;
  const pending = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const currentConversation = useRef(currentThreadId);
  currentConversation.current = currentThreadId;

  const performDelete = useCallback(
    (thread: SidebarSnapshotRow, remember = false) => {
      if (preference.identity !== apiSessionIdentity.getSnapshot() || pending.current.has(thread.id)) return;
      pending.current.add(thread.id);
      setDeletingIds(new Set(pending.current));
      setDeleteDraft(null);
      const isSystem = thread.isHubThread || !!thread.systemKind;
      const url = `/api/threads/${thread.id}${isSystem ? '?force=true' : ''}`;
      void apiFetch(url, { method: 'DELETE' })
        .then(async (response) => {
          if (preference.identity !== apiSessionIdentity.getSnapshot()) return;
          if (!response.ok) {
            const message = response.status === 409 ? copy.workingMessage : copy.failedMessage;
            useToastStore.getState().addToast({ type: 'error', title: copy.failedTitle, message, duration: 5000 });
            return;
          }
          const saved = !remember || isSystem || preference.setConfirmBeforeDelete(false);
          if (thread.id === currentConversation.current) navigateToThread('default');
          await invalidateSidebarProjection();
          if (showTrash) await loadTrash(true);
          useToastStore.getState().addToast({
            type: saved ? 'success' : 'info',
            title: copy.deletedTitle,
            message: saved ? copy.deletedMessage(thread.title ?? copy.unnamed) : copy.deletedPreferenceFailed,
            duration: 5000,
          });
        })
        .catch(() => {
          if (preference.identity !== apiSessionIdentity.getSnapshot()) return;
          useToastStore
            .getState()
            .addToast({ type: 'error', title: copy.failedTitle, message: copy.uncertainMessage, duration: 5000 });
          void invalidateSidebarProjection();
        })
        .finally(() => {
          pending.current.delete(thread.id);
          setDeletingIds(new Set(pending.current));
        });
    },
    [copy, loadTrash, navigateToThread, preference.identity, preference.setConfirmBeforeDelete, showTrash],
  );

  const requestDelete = useCallback(
    (id: string) => {
      if (id === 'default' || pending.current.has(id)) return;
      const thread = projectSidebarRows(useSidebarProjectionStore.getState()).find((row) => row.id === id);
      if (!thread) return;
      if (thread.isHubThread || thread.systemKind || preference.confirmBeforeDelete)
        setDeleteDraft({ thread, identity: preference.identity });
      else performDelete(thread);
    },
    [performDelete, preference.confirmBeforeDelete, preference.identity],
  );
  const confirmDelete = useCallback(
    (remember: boolean) => {
      if (deleteTarget) performDelete(deleteTarget, remember);
    },
    [deleteTarget, performDelete],
  );
  const cancelDelete = useCallback(() => setDeleteDraft(null), []);
  return { deleteTarget, deletingIds, requestDelete, confirmDelete, cancelDelete, canRemember: preference.ready };
}
