import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';

/** Ref-only owner invalidations cause a fresh read; they never assert a save or execute a draft. */
export function useWorkspaceReviewOwnerUpdates(
  reviewId: string | null,
  load: (reviewId: string) => Promise<WorkspaceContentReviewView>,
  onError: (message: string) => void,
) {
  const visible = useWorkspaceSurfaceVisibility();
  const previous = useRef<{ reviewId: string | null; visible: boolean } | null>(null);
  useEffect(() => {
    const returning = previous.current?.reviewId === reviewId && !previous.current.visible;
    previous.current = { reviewId, visible };
    if (!reviewId || !visible) return;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void load(reviewId).catch((error) => {
        if (error instanceof Error && error.message === 'obsolete_content_read') return;
        onError('暂时无法读取最新讨论。当前草稿保留，重新回到作品时会再核对。');
      });
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ reviewId?: string }>).detail?.reviewId === reviewId) refresh();
    };
    if (returning) refresh();
    window.addEventListener('cat-cafe:artifact-review-changed', changed);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('cat-cafe:artifact-review-changed', changed);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reviewId, visible, load, onError]);
}
