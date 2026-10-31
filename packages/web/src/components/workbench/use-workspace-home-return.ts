import { useLayoutEffect, useRef } from 'react';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export type HomeReturnOrigin = Extract<
  WorkspaceFileNavigationOrigin,
  { kind: 'workspace-home-search' | 'workspace-home-artifact' }
>;
const SEARCH_INPUT = '[data-testid="workspace-launcher-search"]';

function returnTarget(home: HTMLElement, origin: HomeReturnOrigin): HTMLElement | null {
  if (origin.kind === 'workspace-home-artifact') {
    return (
      [...home.querySelectorAll<HTMLElement>('[data-home-artifact-id]')].find(
        (card) => card.dataset.homeArtifactId === origin.artifactId,
      ) ?? null
    );
  }
  const input = home.querySelector<HTMLInputElement>(SEARCH_INPUT);
  return input?.value.trim() === origin.query.trim() ? input : null;
}

/** The existing Home scroller owns both ordinary return coordinates, independent of Chat reading state. */
export function useWorkspaceHomeReturn(origin: HomeReturnOrigin | undefined, presentation: string, threadId?: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const home = ref.current;
    if (
      !home ||
      !origin ||
      (home.dataset.homePresentation ?? 'classic') !== presentation ||
      (origin.kind === 'workspace-home-artifact' && origin.threadId !== threadId)
    )
      return;
    let active = true;
    let focused = false;
    const restore = () => {
      if (
        origin.kind === 'workspace-home-artifact' &&
        home.querySelector('[data-home-artifact-return="unavailable"]')
      ) {
        stop();
        return;
      }
      const target = returnTarget(home, origin);
      if (!active || !target || home.clientHeight === 0) return;
      const offset =
        origin.kind === 'workspace-home-artifact'
          ? origin.viewportOffsetPx
          : Math.min(origin.viewportOffsetPx ?? 0, home.clientHeight - target.getBoundingClientRect().height);
      home.scrollTop = Math.max(
        0,
        home.scrollTop + target.getBoundingClientRect().top - home.getBoundingClientRect().top - offset,
      );
      if (!focused) {
        target.focus({ preventScroll: true });
        focused = true;
      }
    };
    const observer = new ResizeObserver(restore);
    const membership =
      origin.kind === 'workspace-home-artifact'
        ? new MutationObserver(() => {
            if (home.querySelector('[data-home-artifact-return="unavailable"]')) stop();
            else restore();
          })
        : null;
    const stop = () => {
      active = false;
      observer.disconnect();
      membership?.disconnect();
    };
    restore();
    observer.observe(home);
    // Natural-height content covers newly inserted sections and later live/wait growth in both shells.
    const content = home.querySelector('[data-workspace-home-content]');
    if (content) {
      observer.observe(content);
      // A ready card can replace an equal-height placeholder; membership need not resize the box.
      membership?.observe(content, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-home-artifact-id', 'data-home-artifact-return'],
      });
    }
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'input'] as const;
    for (const event of events) home.addEventListener(event, stop, { capture: true, passive: true });
    return () => {
      stop();
      for (const event of events) home.removeEventListener(event, stop, true);
    };
  }, [origin, presentation, threadId]);
  return ref;
}
