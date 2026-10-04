'use client';

import { useLayoutEffect, useState } from 'react';
import type { BallReservedRect } from './ball-position';

export const CONCIERGE_RESERVED_RECT_SELECTOR = '[data-concierge-reserved-rect]';

export function readConciergeReservedRects(root: ParentNode = document): readonly BallReservedRect[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CONCIERGE_RESERVED_RECT_SELECTOR)).flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  });
}

function sameRects(left: readonly BallReservedRect[], right: readonly BallReservedRect[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (rect, index) =>
        rect.left === right[index]?.left &&
        rect.top === right[index]?.top &&
        rect.right === right[index]?.right &&
        rect.bottom === right[index]?.bottom,
    )
  );
}

/** Track product-declared Host reservations without coupling Concierge to route names. */
export function useConciergeReservedRects(): readonly BallReservedRect[] {
  const [reservedRects, setReservedRects] = useState<readonly BallReservedRect[]>([]);

  useLayoutEffect(() => {
    const refresh = (force = false) => {
      const next = readConciergeReservedRects();
      setReservedRects((current) => (!force && sameRects(current, next) ? current : next));
    };
    const mutations = new MutationObserver(() => refresh());
    mutations.observe(document.body, { childList: true, subtree: true });
    const resize = () => refresh(true);
    window.addEventListener('resize', resize);
    const layout = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => refresh());
    layout?.observe(document.documentElement);
    refresh();
    return () => {
      mutations.disconnect();
      layout?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  return reservedRects;
}
