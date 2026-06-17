'use client';

/**
 * F229 PR-A3a: ConciergeHost — always-mounted root entry point
 *
 * INV-5: single AppShell instance (mounted at root alongside FloatingPresentationSurfaceHost)
 * INV-6: route survival — host stays mounted across / → /memory → /settings
 * INV-9: lazy config fetch (one GET at idle, triggered here on mount)
 *
 * A3a: Three-layer rendering:
 *   Layer 1: ConciergeBall (always when not hidden)
 *   Layer 2: ConciergeToolbar (surfaceState=toolbar)
 *   Layer 3: ConciergePanel / bubble (surfaceState=bubble)
 *
 * Layout: ball + toolbar share a fixed wrapper (data-testid=concierge-ball-wrapper)
 * so toolbar's `absolute bottom-[calc(100%+8px)] right-0` resolves to that wrapper.
 * Panel has its own independent fixed position (viewport-relative).
 *
 * P1-A cloud fix: toolbar was a Fragment sibling of ConciergeBall's wrapper → no
 *   positioned ancestor → absolute toolbar resolved to initial containing block (off-screen).
 *   Fix: shared positioned wrapper so both ball + toolbar live in the same stacking context.
 *
 * P1-B cloud fix: muted=true → ballState=hidden → early return suppressed panel + toolbar,
 *   making the rail-toggle unmute path unreachable. Fix: when muted+surfaceState≠collapsed
 *   (user explicitly opened toolbar via rail toggle), override hidden→sleeping so the cat
 *   body and toolbar both render, allowing access to the panel's "取消静音" control.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { Rnd } from 'react-rnd';
import { projectBallState, useConciergeStore } from '@/stores/conciergeStore';
import { ConciergeBall } from './ConciergeBall';
import { ConciergePanel } from './ConciergePanel';
import { ConciergeToolbar } from './ConciergeToolbar';

/** Ball button dimensions (V3: 72×72 squircle) */
const BALL_SIZE = 72;
/** Default margin from viewport edge — matches original Tailwind `bottom-6 right-6` (1.5rem = 24px) */
const EDGE_MARGIN = 24;
/** Minimum drag distance (px) to distinguish drag from click (INV-P1) */
const DRAG_THRESHOLD = 5;

export function ConciergeHost() {
  const fetchConfig = useConciergeStore((s) => s.fetchConfig);

  // Lazily load config once (INV-9: only one GET, guard inside fetchConfig)
  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  // P2-A cloud: defer render until config is known — prevents flash of wrong content
  // for users who have enabled=false or muted=true persisted in config.
  // P2 R5: also render if configFailed — network error must not permanently silence the host.
  // All hooks are called above; this conditional return is safe (Rules of Hooks compliant).
  const configLoaded = useConciergeStore((s) => s.configLoaded);
  const configFailed = useConciergeStore((s) => s.configFailed);

  // Derive inputs for projection (subscribe to each field individually to avoid
  // unnecessary re-renders when unrelated store fields change)
  const enabled = useConciergeStore((s) => s.enabled);
  const muted = useConciergeStore((s) => s.muted);
  const invocationStatus = useConciergeStore((s) => s.invocationStatus);
  const pendingConfirmationCount = useConciergeStore((s) => s.pendingConfirmationCount);
  const pendingRelayCount = useConciergeStore((s) => s.pendingRelayCount);
  const unseenResultCount = useConciergeStore((s) => s.unseenResultCount);
  const surfaceState = useConciergeStore((s) => s.surfaceState);
  const inputFocused = useConciergeStore((s) => s.inputFocused);

  // Ball position (PR-A3b INV-P1~P4)
  const ballPosition = useConciergeStore((s) => s.ballPosition);
  const setBallPosition = useConciergeStore((s) => s.setBallPosition);
  const setIsDragging = useConciergeStore((s) => s.setIsDragging);

  // INV-P1: drag threshold — track start position to compare with stop position
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Default position: bottom-right with margin (replaces CSS `fixed bottom-6 right-6`)
  // Memoized once — window dimensions at mount time
  const defaultPosition = useMemo(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    return {
      x: window.innerWidth - BALL_SIZE - EDGE_MARGIN,
      y: window.innerHeight - BALL_SIZE - EDGE_MARGIN,
    };
  }, []);

  // INV-P2: clamp position to viewport on render (handles window resize / persisted
  // out-of-bounds values). Pure computation, no side effect.
  const clampedPosition = useMemo(() => {
    const raw = ballPosition ?? defaultPosition;
    if (typeof window === 'undefined') return raw;
    return {
      x: Math.max(0, Math.min(raw.x, window.innerWidth - BALL_SIZE)),
      y: Math.max(0, Math.min(raw.y, window.innerHeight - BALL_SIZE)),
    };
  }, [ballPosition, defaultPosition]);

  // INV-P2: snap back on viewport resize (position may become out-of-bounds)
  useEffect(() => {
    const handleResize = () => {
      const pos = useConciergeStore.getState().ballPosition;
      if (!pos) return; // default position auto-adapts
      const clamped = {
        x: Math.max(0, Math.min(pos.x, window.innerWidth - BALL_SIZE)),
        y: Math.max(0, Math.min(pos.y, window.innerHeight - BALL_SIZE)),
      };
      if (clamped.x !== pos.x || clamped.y !== pos.y) {
        void setBallPosition(clamped);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [setBallPosition]);

  const handleDragStart = useCallback(
    (_e: unknown, d: { x: number; y: number }) => {
      dragStartPosRef.current = { x: d.x, y: d.y };
      setIsDragging(true);
    },
    [setIsDragging],
  );

  const handleDragStop = useCallback(
    (_e: unknown, d: { x: number; y: number }) => {
      const dx = Math.abs(d.x - dragStartPosRef.current.x);
      const dy = Math.abs(d.y - dragStartPosRef.current.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        // Real drag — persist position. isDragging stays true so ConciergeBall.onClick
        // can suppress the toolbar toggle (reset happens in ConciergeBall.handleClick).
        //
        // Bug fix: flushSync forces React to re-render synchronously within the
        // mouseup handler. Without it, React 18 batches the Zustand update →
        // Rnd re-renders with old clampedPosition before the new position arrives
        // → ball visibly snaps back to origin then jumps to the correct position.
        const pos = { x: d.x, y: d.y };
        flushSync(() => {
          useConciergeStore.setState({ ballPosition: pos });
        });
        // Persist to API (fire-and-forget); local state already synced above.
        void setBallPosition(pos);
      } else {
        // Not a real drag (under threshold) — snap back, treat as click
        setIsDragging(false);
      }
    },
    [setBallPosition, setIsDragging],
  );

  // Wait for config before rendering — but if config fetch failed, render with optimistic
  // defaults so ball/panel are still accessible (rail toggle + retry) (P2 R5)
  if (!configLoaded && !configFailed) return null;

  const ballState = projectBallState({
    enabled,
    muted,
    invocationStatus,
    pendingConfirmationCount,
    pendingRelayCount,
    unseenResultCount,
    surfaceState,
    inputFocused,
  });

  // P1-B cloud fix: muted users who explicitly open toolbar/bubble via rail toggle
  // (surfaceState != collapsed) should see the ball + toolbar so the panel's
  // "取消静音" control is reachable. We override hidden → sleeping only in this case.
  // When surfaceState = collapsed the normal INV-3 "muted → zero DOM" is preserved.
  const effectiveBallState =
    ballState === 'hidden' && muted && surfaceState !== 'collapsed' ? ('sleeping' as const) : ballState;

  // INV-3: hidden → zero DOM (no ball, no badge, no tooltip, no toolbar, no bubble)
  if (effectiveBallState === 'hidden') return null;

  return (
    <>
      {/* PR-A3b: Rnd wrapper replaces static `fixed bottom-6 right-6` div.
          - INV-P1: drag threshold ~5px (handleDragStart/handleDragStop above)
          - INV-P2: bounds="window" + clampedPosition keep ball in viewport
          - INV-P3: persist position via config PUT in setBallPosition
          - INV-P4: muted→unmuted position retained (position is in ConciergeConfig)
          P1-A cloud fix still applies: toolbar resolves relative to this wrapper. */}
      <Rnd
        data-testid="concierge-ball-wrapper"
        position={clampedPosition}
        size={{ width: BALL_SIZE, height: BALL_SIZE }}
        enableResizing={false}
        bounds="window"
        onDragStart={handleDragStart}
        onDragStop={handleDragStop}
        style={{ position: 'fixed', zIndex: 30, pointerEvents: 'none' }}
      >
        {/* Layer 1: Cat body */}
        <ConciergeBall ballState={effectiveBallState} />
        {/* Layer 2: Ability toolbar — absolute, resolves relative to this wrapper */}
        <ConciergeToolbar />
      </Rnd>

      {/* Layer 3: Comic bubble — `position: fixed` with explicit viewport coordinates;
          not inside the wrapper above (a fixed ancestor without transform/filter does not
          create a new containing block for fixed descendants per CSS spec) */}
      <ConciergePanel />
    </>
  );
}
