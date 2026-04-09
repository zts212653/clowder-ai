/**
 * F095 Phase E: Scroll anchor hook for ThreadSidebar.
 *
 * Problem: When threads reorder (active thread jumps up), the scroll container
 * keeps its pixel scrollTop but the content has shifted — the user loses their place.
 *
 * Solution: On every scroll event, capture the first visible thread element and its
 * position relative to the container. After a reorder re-render, find that element's
 * new position and adjust scrollTop to compensate for the drift.
 */

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

interface ScrollAnchor {
  threadId: string;
  /** Distance from container top to the anchor element top (px) */
  offsetFromTop: number;
}

/** Minimum scrollTop before we bother anchoring (skip when at the top). */
const ANCHOR_THRESHOLD_PX = 40;

/** Minimum drift to correct (avoids sub-pixel jitter). */
const DRIFT_TOLERANCE_PX = 2;

/** Session-scoped scroll memory for thread switches/remounts. */
const SCROLL_MEMORY_KEY = 'cat-cafe:sidebar:scrollTop';

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readPersistedScrollTop(): number | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  const raw = storage.getItem(SCROLL_MEMORY_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function writePersistedScrollTop(value: number) {
  const storage = getSessionStorage();
  if (!storage) return;
  storage.setItem(SCROLL_MEMORY_KEY, String(Math.max(0, Math.round(value))));
}

/**
 * Keeps the visible content in place when thread list reorders.
 *
 * @param containerRef - ref to the scrollable container div
 * @param threadGroups - the current sorted/grouped thread data (used as effect dep)
 */
export function useScrollAnchor(
  containerRef: RefObject<HTMLDivElement | null>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  threadGroups: readonly unknown[],
) {
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const pendingRestoreRef = useRef<number | null>(readPersistedScrollTop());
  /** Tracks the last known scrollTop — safe to read even after DOM detach. */
  const lastScrollTopRef = useRef(readPersistedScrollTop() ?? 0);

  const persistScrollTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    lastScrollTopRef.current = container.scrollTop;
    writePersistedScrollTop(container.scrollTop);
  }, [containerRef]);

  /** Record the first visible `[data-thread-id]` element as anchor. */
  const captureAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = container.querySelectorAll('[data-thread-id]');
    const containerTop = container.getBoundingClientRect().top;

    for (const item of items) {
      const rect = item.getBoundingClientRect();
      // First element whose bottom is still visible
      if (rect.bottom > containerTop) {
        const threadId = item.getAttribute('data-thread-id');
        if (!threadId) continue;
        anchorRef.current = {
          threadId,
          offsetFromTop: rect.top - containerTop,
        };
        return;
      }
    }
  }, [containerRef]);

  /** Scroll handler — attach to the container's onScroll. */
  const onScroll = useCallback(() => {
    persistScrollTop();
    captureAnchor();
  }, [captureAnchor, persistScrollTop]);

  /** Preserve the latest position even if the sidebar unmounts immediately after a click.
   *  Writes from lastScrollTopRef — NOT from containerRef which may be detached. */
  useEffect(
    () => () => {
      writePersistedScrollTop(lastScrollTopRef.current);
    },
    [],
  );

  /**
   * Restore scrollTop after route-driven remounts.
   * This covers the "click a thread near the bottom → sidebar snaps back to top" path,
   * which is separate from the reorder drift handled below.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: rerun when threadGroups identity changes so async thread loads can restore scroll after remount
  useLayoutEffect(() => {
    const container = containerRef.current;
    const pendingTop = pendingRestoreRef.current;
    if (!container || pendingTop === null) return;

    if (Math.abs(container.scrollTop - pendingTop) > DRIFT_TOLERANCE_PX) {
      container.scrollTop = pendingTop;
    }

    // Only clear pending + persist if the assignment actually took effect.
    // If the container is too short (e.g., groups collapsed), keep pending for the
    // next effect run (triggered when threadGroups identity changes after API fetch).
    if (Math.abs(container.scrollTop - pendingTop) <= DRIFT_TOLERANCE_PX) {
      captureAnchor();
      persistScrollTop();
      pendingRestoreRef.current = null;
    }
  }, [containerRef, captureAnchor, persistScrollTop, threadGroups]);

  /**
   * After React commits DOM changes (layout phase), check if the anchor
   * element drifted and compensate scrollTop.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally keys off threadGroups reordering while reading live refs
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = containerRef.current;

    // Don't anchor if user is near the top — let natural reorder show newest items
    if (!anchor || !container || container.scrollTop < ANCHOR_THRESHOLD_PX) return;

    const selector = `[data-thread-id="${CSS.escape(anchor.threadId)}"]`;
    const el = container.querySelector(selector);
    if (!el) return;

    const containerTop = container.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    const drift = elTop - containerTop - anchor.offsetFromTop;

    if (Math.abs(drift) > DRIFT_TOLERANCE_PX) {
      container.scrollTop += drift;
      // Update stored anchor to reflect corrected position
      anchorRef.current = {
        ...anchor,
        offsetFromTop: el.getBoundingClientRect().top - container.getBoundingClientRect().top,
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef is a live ref, not a dependency
  }, [threadGroups]);

  return { onScroll };
}
