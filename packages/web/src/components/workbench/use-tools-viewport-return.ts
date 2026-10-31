import { useLayoutEffect } from 'react';
import type { WorkspaceMenuContext } from '@/components/workspace/V2WorkspaceMenu';

export interface ToolsReturnRequest {
  readonly generation: number;
  readonly threadId?: string;
  readonly worktreeId: string | null;
  readonly query: string;
  /** Absent for old Home origins: their coordinate does not belong to this popup. */
  readonly viewportOffsetPx?: number;
}

/** Compensate only the original menu viewport within one accepted Back generation. */
export function useToolsViewportReturn(menu: WorkspaceMenuContext, request?: ToolsReturnRequest) {
  useLayoutEffect(() => {
    const viewport = menu.viewport.current;
    if (!menu.open || !request || !viewport) return;
    let active = true;
    const restore = () => {
      const input = viewport.querySelector<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
      if (!active || !input || input.value.trim() !== request.query || viewport.clientHeight === 0) return;
      const offset = request.viewportOffsetPx;
      if (offset === undefined) viewport.scrollTop = 0;
      else
        viewport.scrollTop = Math.min(
          Math.max(0, viewport.scrollHeight - viewport.clientHeight),
          Math.max(
            0,
            viewport.scrollTop + input.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset,
          ),
        );
    };
    const resize = new ResizeObserver(restore);
    const membership = new MutationObserver(restore);
    const stop = () => {
      active = false;
      resize.disconnect();
      membership.disconnect();
    };
    resize.observe(viewport);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    // Placement can change top without resizing; same-height result replacement also needs delivery.
    membership.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    const inputEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'input'] as const;
    for (const event of inputEvents) viewport.addEventListener(event, stop, { capture: true, passive: true });
    restore();
    return () => {
      stop();
      for (const event of inputEvents) viewport.removeEventListener(event, stop, true);
    };
  }, [menu.open, menu.viewport, request]);
}
