'use client';

import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { ArtifactListView } from './artifact-list-state';

/** Each navigation's return settles with preview dimensions; new user input ends that restoration. */
export function useWorksViewportReturn(
  scroll: RefObject<HTMLDivElement | null>,
  viewport: ArtifactListView['viewport'],
  ready: boolean,
) {
  const restored = useRef<ArtifactListView['viewport']>(undefined);
  useLayoutEffect(() => {
    const list = scroll.current;
    // Equal coordinates can be a new return on the same retained Works component.
    if (!viewport || restored.current === viewport || !ready || !list) return;
    const card = viewport.anchor
      ? [...list.querySelectorAll<HTMLElement>('[data-work-anchor]')].find(
          (node) => node.dataset.workAnchor === viewport.anchor?.key,
        )
      : undefined;
    const restore = () => {
      list.scrollTop = viewport.scrollTop;
      if (card && viewport.anchor)
        list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - viewport.anchor.offset;
    };
    let frame: number | null = null;
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      list.removeEventListener('load', schedule, true);
      list.removeEventListener('error', schedule, true);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list.removeEventListener(event, finish);
    };
    const finish = () => {
      restored.current = viewport;
      stop();
    };
    const settle = () => {
      frame = null;
      restore();
      if ([...list.querySelectorAll('img')].every((image) => image.complete)) finish();
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      // React's failed-preview replacement can change the card after its image error handler.
      frame = requestAnimationFrame(settle);
    };
    list.addEventListener('load', schedule, true);
    list.addEventListener('error', schedule, true);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      list.addEventListener(event, finish, { passive: true });
    settle();
    card
      ?.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')
      ?.focus({ preventScroll: true });
    return stop;
  }, [ready, scroll, viewport]);
}
