/**
 * F229 Phase E4: Autonomous Behavior Engine — React hook.
 *
 * Wires pure functions from petBehaviorCore.ts to React state + timers.
 * All testable logic lives in petBehaviorCore (zero React dependency).
 *
 * Re-exports everything from petBehaviorCore for backward compatibility
 * so existing imports from './usePetBehavior' continue to work.
 */

import type { ConciergeBallState, PetBehaviorOutput } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';

import {
  computeAmbientBehavior,
  computeBehaviorPhase,
  computeEventBehavior,
  IDLE_ENTRY_DELAY_MS,
  MESSAGE_BOUNCE_DURATION_MS,
} from './petBehaviorCore';

export type { AmbientBehaviorInput, BehaviorPhase, EventBehaviorInput } from './petBehaviorCore';
// Re-export everything from petBehaviorCore for backward compatibility
export {
  computeAmbientBehavior,
  computeBehaviorPhase,
  computeEventBehavior,
  IDLE_ENTRY_DELAY_MS,
  IDLE_REMINDER_DELAY_MS,
  IDLE_REMINDER_PROXIMITY_PX,
  MESSAGE_BOUNCE_COOLDOWN_MS,
  MESSAGE_BOUNCE_DURATION_MS,
  WALK_COOLDOWN_MS,
} from './petBehaviorCore';

// ---------------------------------------------------------------------------
// React hook — wires pure functions to React state + timers
// ---------------------------------------------------------------------------

/** Tick interval for the autonomous animation loop (60fps would be 16ms, we use ~15fps). */
const TICK_INTERVAL_MS = 66;

/** Options for the usePetBehavior hook. */
export interface UsePetBehaviorOptions {
  /** Current ConciergeBallState (read-only, AC-E4-2). */
  ballState: ConciergeBallState;
  /** Whether autonomous behavior is enabled (AC-E4-7). */
  behaviorEnabled: boolean;
  /** Whether concierge is muted (disables autonomous behavior). */
  muted: boolean;
  /** Current ball position (from Rnd wrapper). */
  ballPosition: { x: number; y: number };
  /** Current ball size in px (E3 resize support). Used for proximity center calculation. */
  ballSize: number;
  /** Timestamp of the last incoming message (for 消息惊起). */
  lastMessageTimestamp: number;
}

/**
 * React hook: Autonomous Behavior Engine (AC-E4-1).
 *
 * Reads business state, outputs visual overlay. Never writes to ConciergeBallState.
 * When autonomous is active, returns a visual override; otherwise returns null fields.
 */
export function usePetBehavior(opts: UsePetBehaviorOptions): PetBehaviorOutput {
  const { ballState, behaviorEnabled, muted, ballPosition, ballSize, lastMessageTimestamp } = opts;
  const enabled = behaviorEnabled && !muted;

  // Track when ball entered idle/sleeping for hysteresis
  const idleEnteredAtRef = useRef<number | null>(null);
  const lastBounceRef = useRef(0);
  const lastWalkEndRef = useRef(0);
  const lastUserActivityAtRef = useRef(Date.now());

  // E4 P1 fix: track mouse position for idle reminder proximity wake (AC-E4-5)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });
  useEffect(() => {
    const markUserActivity = () => {
      lastUserActivityAtRef.current = Date.now();
    };
    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      markUserActivity();
    };
    const handleUserActivity = () => markUserActivity();
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('pointerdown', handleUserActivity, { passive: true });
    window.addEventListener('keydown', handleUserActivity);
    window.addEventListener('touchstart', handleUserActivity, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointerdown', handleUserActivity);
      window.removeEventListener('keydown', handleUserActivity);
      window.removeEventListener('touchstart', handleUserActivity);
    };
  }, []);

  // Track phase and autonomous elapsed time
  const [output, setOutput] = useState<PetBehaviorOutput>({
    visualState: null,
    overlay: null,
    positionDelta: null,
    isAutonomousActive: false,
  });

  // Detect idle entry/exit for hysteresis timing
  const isIdle = ballState === 'idle' || ballState === 'sleeping';

  useEffect(() => {
    if (isIdle && enabled) {
      if (idleEnteredAtRef.current === null) {
        idleEnteredAtRef.current = Date.now();
      }
    } else {
      idleEnteredAtRef.current = null;
      // Business state immediately interrupts autonomous (zero delay)
      setOutput({
        visualState: null,
        overlay: null,
        positionDelta: null,
        isAutonomousActive: false,
      });
    }
  }, [isIdle, enabled]);

  // Animation tick loop — only runs when idle + enabled
  useEffect(() => {
    if (!isIdle || !enabled) return;

    const tick = () => {
      const now = Date.now();
      const idleEnteredAt = idleEnteredAtRef.current;
      if (idleEnteredAt === null) return;

      const idleElapsedMs = now - idleEnteredAt;

      // --- EventBehavior: independent of phase (spec §B 双子系统, line 196) ---
      // 消息惊起 runs during idle-countdown AND autonomous, not gated by 10s delay
      const eventResult = computeEventBehavior({
        lastMessageTimestamp,
        lastBounceTimestamp: lastBounceRef.current,
        currentTimestamp: now,
      });

      if (eventResult) {
        // Track bounce START (not continuation ticks) for duration/cooldown
        if (eventResult.visualState === 'jumping') {
          if (lastBounceRef.current === 0 || now - lastBounceRef.current >= MESSAGE_BOUNCE_DURATION_MS) {
            lastBounceRef.current = now;
          }
        }
        setOutput({ ...eventResult, isAutonomousActive: true });
        return;
      }

      // --- AmbientBehavior: only during autonomous phase ---
      const phase = computeBehaviorPhase(ballState, idleElapsedMs, true);

      if (phase !== 'autonomous') {
        setOutput({
          visualState: null,
          overlay: null,
          positionDelta: null,
          isAutonomousActive: false,
        });
        return;
      }

      // Compute ambient behavior (idle reminder + walk)
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };

      // E4 P1 fix: calculate actual mouse distance to ball center (AC-E4-5 proximity wake)
      // R2-4 fix: use dynamic ballSize instead of hardcoded 36 (E3 allows 48-192px)
      const mp = mousePosRef.current;
      const halfSize = ballSize / 2;
      const ballCenterX = ballPosition.x + halfSize;
      const ballCenterY = ballPosition.y + halfSize;
      const mouseDistance = mp.x < 0 ? 9999 : Math.sqrt((mp.x - ballCenterX) ** 2 + (mp.y - ballCenterY) ** 2);

      const result = computeAmbientBehavior({
        autonomousElapsedMs: idleElapsedMs - IDLE_ENTRY_DELAY_MS,
        currentTimestamp: now,
        userIdleSinceMs: idleElapsedMs,
        lastUserActivityTimestamp: lastUserActivityAtRef.current,
        mouseDistance,
        lastWalkEndTimestamp: lastWalkEndRef.current,
        walkSeed: Math.random(),
        viewport,
        ballPosition,
      });

      // Track walk timestamps for cooldown
      if (result.positionDelta) {
        lastWalkEndRef.current = now;
      }

      setOutput({
        ...result,
        isAutonomousActive: true,
      });
    };

    const intervalId = setInterval(tick, TICK_INTERVAL_MS);
    // Run immediately on mount
    tick();

    return () => clearInterval(intervalId);
  }, [isIdle, enabled, ballState, lastMessageTimestamp, ballPosition, ballSize]);

  return output;
}
