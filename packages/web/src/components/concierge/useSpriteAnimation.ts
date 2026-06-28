/**
 * F229 Phase E1: Sprite atlas animation hook.
 *
 * Drives frame-by-frame animation for atlas-based pet skins.
 * Returns current frame index + CSS backgroundPosition for the spritesheet.
 *
 * - Uses setTimeout chain (not requestAnimationFrame) for per-frame timing control.
 * - Respects prefers-reduced-motion: pauses animation at frame 0.
 * - Resets to frame 0 when config changes (state transition).
 *
 * Pure computation helpers are exported for unit testing.
 * The hook itself is a thin wrapper around these + React state + timers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Pure computation helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute CSS background-position for a given frame in the atlas.
 * Column = frameIndex, Row = row. Position is negative (standard CSS sprite offset).
 */
export function computeBackgroundPosition(
  frameIndex: number,
  row: number,
  cellWidth: number,
  cellHeight: number,
): string {
  const x = -(frameIndex * cellWidth);
  const y = -(row * cellHeight);
  return `${x}px ${y}px`;
}

/**
 * Compute next frame index, wrapping around at frameCount.
 */
export function nextFrame(current: number, frameCount: number): number {
  return (current + 1) % frameCount;
}

/**
 * Compute a stable config key for detecting state transitions.
 * When the key changes, animation resets to frame 0.
 */
export function computeConfigKey(row: number, frameCount: number): string {
  return `${row}-${frameCount}`;
}

/**
 * Compute display-coordinate background-position for a scaled atlas sprite.
 *
 * When atlas cell dimensions (e.g. 192×208) don't match the display size
 * (e.g. 59×64), positions must be computed in integer display coordinates
 * directly — NOT by scaling raw cell positions with a single float factor,
 * which causes rounding drift on non-square cells (e.g. frame 7 of 8-col
 * atlas: -414px vs correct -413px).
 */
export function computeScaledBackgroundPosition(
  frameIndex: number,
  row: number,
  displayWidth: number,
  displayHeight: number,
): string {
  const x = -(frameIndex * displayWidth);
  const y = -(row * displayHeight);
  return `${x}px ${y}px`;
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

/** Config for one animation state row in the atlas. */
export interface SpriteAnimationConfig {
  /** Number of frames in this animation state */
  frameCount: number;
  /** Per-frame duration in ms (length === frameCount) */
  frameDurations: number[];
  /** 0-based row index in the atlas */
  row: number;
  /** Cell width in pixels */
  cellWidth: number;
  /** Cell height in pixels */
  cellHeight: number;
}

/** Return value from useSpriteAnimation. */
export interface SpriteAnimationState {
  /** Current frame index (0-based) */
  frameIndex: number;
  /** CSS background-position string for the current frame. */
  backgroundPosition: string;
}

// ---------------------------------------------------------------------------
// Reduced motion detection
// ---------------------------------------------------------------------------

/**
 * Check if prefers-reduced-motion is active.
 * Returns false in SSR / environments without matchMedia.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook: drive sprite animation for an atlas-based pet skin.
 *
 * @param config — animation config for the current pet state row
 * @returns current frame index + CSS backgroundPosition
 */
export function useSpriteAnimation(config: SpriteAnimationConfig): SpriteAnimationState {
  const [frameIndex, setFrameIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect config change (pet state transition) → reset to frame 0
  const configKeyRef = useRef(computeConfigKey(config.row, config.frameCount));
  const currentKey = computeConfigKey(config.row, config.frameCount);
  if (currentKey !== configKeyRef.current) {
    configKeyRef.current = currentKey;
    setFrameIndex(0);
  }

  const advance = useCallback(() => {
    setFrameIndex((prev) => nextFrame(prev, config.frameCount));
  }, [config.frameCount]);

  useEffect(() => {
    // Respect reduced-motion: freeze at current frame
    if (prefersReducedMotion()) {
      return;
    }

    // Schedule next frame advancement
    const duration = config.frameDurations[frameIndex] ?? 200;
    timerRef.current = setTimeout(advance, duration);

    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [frameIndex, config.frameDurations, advance]);

  const backgroundPosition = computeBackgroundPosition(frameIndex, config.row, config.cellWidth, config.cellHeight);

  return { frameIndex, backgroundPosition };
}
