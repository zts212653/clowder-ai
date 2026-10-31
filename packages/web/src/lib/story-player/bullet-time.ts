/**
 * F252 Phase E PR E-2 — Bullet Time Easing (AC-E4 partial)
 *
 * Pure easing function for smooth speed transitions at pass-ball events.
 * No side effects, no state — just a progressMs → speedFactor mapping.
 *
 * Three-phase curve:
 * 1. Decelerate (DECEL_MS): ease from 1.0 → MIN_SPEED_FACTOR
 * 2. Hold (HOLD_MS): stay at MIN_SPEED_FACTOR
 * 3. Accelerate (ACCEL_MS): ease from MIN_SPEED_FACTOR → 1.0
 *
 * Replaces the step-function PASS_BALL_SLOWDOWN_FACTOR with a smooth curve
 * that gives viewers time to notice pass-ball events during high-speed replay.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deceleration phase duration (ms) — ramp down from full speed */
export const DECEL_MS = 400;

/** Hold phase duration (ms) — stay at minimum speed */
export const HOLD_MS = 1000;

/** Acceleration phase duration (ms) — ramp back up to full speed */
export const ACCEL_MS = 600;

/** Total bullet time duration (ms) */
export const BULLET_TIME_TOTAL_MS = DECEL_MS + HOLD_MS + ACCEL_MS;

/**
 * Minimum speed factor during hold phase.
 * At 100× base speed, 0.01 → effective 1× (nearly paused).
 * At 10× base speed, 0.01 → effective 0.1× (very slow).
 */
export const MIN_SPEED_FACTOR = 0.01;

// ---------------------------------------------------------------------------
// Easing function
// ---------------------------------------------------------------------------

/**
 * Compute the speed factor for a given bullet time progress.
 *
 * Returns a value in [MIN_SPEED_FACTOR, 1.0]:
 * - 1.0 = full speed (no slowdown)
 * - MIN_SPEED_FACTOR = maximum slowdown
 *
 * INV-3: Return value is always in [MIN_SPEED_FACTOR, 1.0] for any input.
 */
export function bulletTimeSpeedFactor(progressMs: number): number {
  // Before start or after end → no slowdown
  if (progressMs <= 0 || progressMs >= BULLET_TIME_TOTAL_MS) return 1.0;

  const range = 1.0 - MIN_SPEED_FACTOR;

  // Phase 1: Decelerate (0 → DECEL_MS)
  // Linear interpolation from 1.0 → MIN_SPEED_FACTOR
  if (progressMs <= DECEL_MS) {
    const t = progressMs / DECEL_MS; // 0→1
    return 1.0 - range * t;
  }

  // Phase 2: Hold (DECEL_MS → DECEL_MS + HOLD_MS)
  if (progressMs <= DECEL_MS + HOLD_MS) {
    return MIN_SPEED_FACTOR;
  }

  // Phase 3: Accelerate (DECEL_MS + HOLD_MS → TOTAL)
  // Linear interpolation from MIN_SPEED_FACTOR → 1.0
  const accelProgress = progressMs - DECEL_MS - HOLD_MS;
  const t = accelProgress / ACCEL_MS; // 0→1
  return MIN_SPEED_FACTOR + range * t;
}
