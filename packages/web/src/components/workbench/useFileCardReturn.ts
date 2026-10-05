'use client';

import { useEffect, useRef } from 'react';
import { FILE_RETURN_EVENT, FILE_RETURN_PARAM } from './file-card-origin';
import { useWorkspaceSurfaceVisibility } from './WorkspaceSurfaceVisibility';

export function useFileCardReturn<T extends HTMLElement>(anchorId: string, threadId?: string) {
  const ref = useRef<T>(null);
  const visible = useWorkspaceSurfaceVisibility();
  useEffect(() => {
    const restore = () => {
      const element = ref.current;
      if (!visible || !element) return;
      const url = new URL(window.location.href);
      const raw = url.searchParams.get(FILE_RETURN_PARAM);
      if (!raw || raw.length > 12000) return;
      let position: { anchorId?: unknown; viewportOffsetPx?: unknown; threadId?: unknown };
      try {
        position = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !position ||
        position.anchorId !== anchorId ||
        (position.threadId !== undefined && position.threadId !== threadId) ||
        typeof position.viewportOffsetPx !== 'number' ||
        !Number.isFinite(position.viewportOffsetPx)
      )
        return;
      const container = element.closest<HTMLElement>('[data-trajectory-origin-scroll], [data-file-origin-scroll]');
      if (!container) return;
      container.scrollTop = Math.max(
        0,
        container.scrollTop +
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          position.viewportOffsetPx,
      );
      element.focus({ preventScroll: true });
      if (document.activeElement !== element) return;
      url.searchParams.delete(FILE_RETURN_PARAM);
      window.history.replaceState(window.history.state, '', url);
    };
    restore();
    window.addEventListener(FILE_RETURN_EVENT, restore);
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener(FILE_RETURN_EVENT, restore);
      window.removeEventListener('popstate', restore);
    };
  }, [anchorId, visible, threadId]);
  return ref;
}
