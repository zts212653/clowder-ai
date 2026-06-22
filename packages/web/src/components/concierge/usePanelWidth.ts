/**
 * F229 BUG-UX-3: Panel dimension state + resize logic (width + height).
 *
 * Extracted from ConciergePanel.tsx (gpt52 R5 P1: file exceeded 350-line limit).
 * Contains:
 *   - Width constants (PANEL_MIN_W / MAX / DEFAULT / MARGIN)
 *   - Height constants (PANEL_MIN_H / MAX / DEFAULT / MARGIN_V)
 *   - Pure clamping helpers (exported for unit testing)
 *   - usePanelWidth hook (state + localStorage + viewport resize + drag handlers)
 */

import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Panel width constants + pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export const PANEL_MIN_W = 280;
export const PANEL_MAX_W = 560;
export const PANEL_DEFAULT_W = 384; // was w-80=320, widened for readability
export const PANEL_MARGIN = 48; // 24px margin each side

/** Clamp a width to viewport bounds. Viewport constraint ALWAYS wins over PANEL_MIN_W —
 *  a too-narrow panel is better than one that overflows the left edge. */
export function clampPanelWidth(w: number, viewportWidth: number): number {
  const maxViewportW = viewportWidth - PANEL_MARGIN;
  const effectiveMin = Math.min(PANEL_MIN_W, maxViewportW);
  return Math.max(effectiveMin, Math.min(w, PANEL_MAX_W, maxViewportW));
}

/** Resolve the initial panel width from a localStorage value + current viewport.
 *  Accepts any positive finite saved value; clamp handles viewport bounds. */
export function resolveInitialPanelWidth(saved: string | null, viewportWidth: number): number {
  const maxViewportW = viewportWidth - PANEL_MARGIN;
  const effectiveMin = Math.min(PANEL_MIN_W, maxViewportW);
  const effectiveMax = Math.min(PANEL_MAX_W, maxViewportW);
  if (saved) {
    const n = Number(saved);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(effectiveMin, Math.min(n, effectiveMax));
    }
  }
  return Math.max(effectiveMin, Math.min(PANEL_DEFAULT_W, effectiveMax));
}

// ---------------------------------------------------------------------------
// Panel height constants + pure helpers (exported for testing)
// ---------------------------------------------------------------------------

// R1 P1: minimum must exceed real layout minimum (~238px = header + message min-h + input).
// 280 provides safe margin; matches PANEL_MIN_W coincidentally.
export const PANEL_MIN_H = 280;
export const PANEL_MAX_H = 700;
export const PANEL_DEFAULT_H = 400;
/** Bottom offset (24+72+16=112) + 24px top margin = 136px reserved vertical space */
export const PANEL_MARGIN_V = 136;

/** Clamp a height to viewport bounds. Same logic as width: viewport constraint wins. */
export function clampPanelHeight(h: number, viewportHeight: number): number {
  const maxViewportH = viewportHeight - PANEL_MARGIN_V;
  const effectiveMin = Math.min(PANEL_MIN_H, maxViewportH);
  return Math.max(effectiveMin, Math.min(h, PANEL_MAX_H, maxViewportH));
}

/** Resolve the initial panel height from a localStorage value + current viewport. */
export function resolveInitialPanelHeight(saved: string | null, viewportHeight: number): number {
  const maxViewportH = viewportHeight - PANEL_MARGIN_V;
  const effectiveMin = Math.min(PANEL_MIN_H, maxViewportH);
  const effectiveMax = Math.min(PANEL_MAX_H, maxViewportH);
  if (saved) {
    const n = Number(saved);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(effectiveMin, Math.min(n, effectiveMax));
    }
  }
  return Math.max(effectiveMin, Math.min(PANEL_DEFAULT_H, effectiveMax));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const PANEL_WIDTH_STORAGE_KEY = 'concierge-panel-width';
const PANEL_HEIGHT_STORAGE_KEY = 'concierge-panel-height';

export interface UsePanelWidthReturn {
  panelWidth: number;
  panelHeight: number;
  handleResizePointerDown: (e: PointerEvent) => void;
  handleResizePointerMove: (e: PointerEvent) => void;
  handleResizePointerUp: () => void;
  handleHeightResizePointerDown: (e: PointerEvent) => void;
  handleHeightResizePointerMove: (e: PointerEvent) => void;
  handleHeightResizePointerUp: () => void;
}

export function usePanelWidth(): UsePanelWidthReturn {
  const clampWidth = useCallback((w: number) => {
    if (typeof window === 'undefined') return w;
    return clampPanelWidth(w, window.innerWidth);
  }, []);

  const clampHeight = useCallback((h: number) => {
    if (typeof window === 'undefined') return h;
    return clampPanelHeight(h, window.innerHeight);
  }, []);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return PANEL_DEFAULT_W;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    } catch {
      // Storage unavailable (restricted iframe / corporate policy) — use default
    }
    return resolveInitialPanelWidth(saved, window.innerWidth);
  });

  const [panelHeight, setPanelHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return PANEL_DEFAULT_H;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY);
    } catch {
      // Storage unavailable — use default
    }
    return resolveInitialPanelHeight(saved, window.innerHeight);
  });

  const resizeDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const heightDragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Re-clamp both dimensions on viewport resize
  useEffect(() => {
    const handleResize = () => {
      setPanelWidth((prev) => clampPanelWidth(prev, window.innerWidth));
      setPanelHeight((prev) => clampPanelHeight(prev, window.innerHeight));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- Width resize handlers (left edge) ---

  const handleResizePointerDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeDragRef.current = { startX: e.clientX, startW: panelWidth };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panelWidth],
  );

  const handleResizePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!resizeDragRef.current) return;
      // Panel grows leftward (anchored right-6), so moving left = wider
      const delta = resizeDragRef.current.startX - e.clientX;
      const newW = clampWidth(resizeDragRef.current.startW + delta);
      setPanelWidth(newW);
    },
    [clampWidth],
  );

  const handleResizePointerUp = useCallback(() => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    } catch {
      // Storage unavailable — width not persisted, non-critical
    }
  }, [panelWidth]);

  // --- Height resize handlers (top edge) ---

  const handleHeightResizePointerDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      heightDragRef.current = { startY: e.clientY, startH: panelHeight };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panelHeight],
  );

  const handleHeightResizePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!heightDragRef.current) return;
      // Panel grows upward (anchored at bottom), so moving up = taller
      const delta = heightDragRef.current.startY - e.clientY;
      const newH = clampHeight(heightDragRef.current.startH + delta);
      setPanelHeight(newH);
    },
    [clampHeight],
  );

  const handleHeightResizePointerUp = useCallback(() => {
    if (!heightDragRef.current) return;
    heightDragRef.current = null;
    try {
      localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(panelHeight));
    } catch {
      // Storage unavailable — height not persisted, non-critical
    }
  }, [panelHeight]);

  return {
    panelWidth,
    panelHeight,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    handleHeightResizePointerDown,
    handleHeightResizePointerMove,
    handleHeightResizePointerUp,
  };
}
