import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { resolveFileTarget } from './real-surface-adapters';

/** Connect the original viewer viewport ports to the original lock snapshot, fenced to this owner. */
export function useWorkspaceFileViewport(surfaceId: string, target: { worktreeId: string; path: string }) {
  const lock = useChatStore((state) => state.presentationLock);
  const matchesLock =
    lock &&
    (lock.surfaceId === undefined || lock.surfaceId === surfaceId) &&
    lock.worktreeId === target.worktreeId &&
    lock.filePath === target.path;
  const onScrollTopChange = useCallback(
    (scrollTop: number) => {
      const chat = useChatStore.getState();
      const currentLock = chat.presentationLock;
      if (currentLock) {
        if (
          (currentLock.surfaceId === undefined || currentLock.surfaceId === surfaceId) &&
          currentLock.worktreeId === target.worktreeId &&
          currentLock.filePath === target.path
        ) {
          chat.setPresentationLockViewport(scrollTop);
        }
        return;
      }
      const layout = useF307ExperienceWorkbenchStore.getState().layout;
      const active = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
      const file = active && resolveFileTarget(active);
      if (active?.id === surfaceId && file?.worktreeId === target.worktreeId && file?.path === target.path) {
        chat.setWorkspaceViewport(scrollTop);
      }
    },
    [surfaceId, target.path, target.worktreeId],
  );
  return {
    restoreScrollTop: matchesLock ? lock.scrollTop : null,
    restoreKey: matchesLock ? `${lock.ownerThreadId}:${surfaceId}:${target.worktreeId}:${target.path}` : undefined,
    onScrollTopChange,
  };
}
