/**
 * F229 Phase E4: Autonomous Behavior Engine — pure computation core.
 *
 * Contains all testable pure functions with zero React dependency:
 * - computeBehaviorPhase: dual-input priority composition (AC-E4-1)
 * - computeEventBehavior: event-driven behavior — message bounce (AC-E4-3, spec §B EventBehavior)
 * - computeAmbientBehavior: ambient behavior priority chain (AC-E4-4/5)
 * - computeWalkDelta: center-avoiding random walk (AC-E4-4 + AC-E4-6)
 *
 * State isolation (AC-E4-2): ConciergeBallState is read-only input.
 * Autonomous layer outputs visual overlay — never writes to ball state.
 *
 * The React hook (usePetBehavior.ts) wires these to timers/effects.
 */

import type { CodexPetState, ConciergeBallState, PetBehaviorOutput } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Timing constants (exported for test assertions)
// ---------------------------------------------------------------------------

/** Idle hysteresis — ball must stay idle/sleeping this long before autonomous activates. */
export const IDLE_ENTRY_DELAY_MS = 10_000;

/** Duration of jump animation on new message (AC-E4-3). */
export const MESSAGE_BOUNCE_DURATION_MS = 2_000;

/** Minimum interval between message bounces (AC-E4-3: 5s cooldown). */
export const MESSAGE_BOUNCE_COOLDOWN_MS = 5_000;

/** Minimum interval between random walks (AC-E4-4: max 1/2min). */
export const WALK_COOLDOWN_MS = 120_000;

/** User idle duration before waving+💤 (AC-E4-5: 5min). */
export const IDLE_REMINDER_DELAY_MS = 300_000;

/** Mouse proximity threshold to wake from idle reminder (px). */
export const IDLE_REMINDER_PROXIMITY_PX = 80;

// ---------------------------------------------------------------------------
// Phase computation (AC-E4-1: dual-input priority composition)
// ---------------------------------------------------------------------------

/** Behavior engine phase — internal state machine for the hook. */
export type BehaviorPhase = 'business' | 'idle-countdown' | 'autonomous';

/**
 * Pure phase computation.
 *
 * @param ballState   Current ConciergeBallState (read-only, AC-E4-2)
 * @param idleElapsedMs  Milliseconds since ball entered idle/sleeping
 * @param behaviorEnabled  Config toggle (AC-E4-7)
 * @returns Current phase
 *
 * INV: phase === 'autonomous' → ballState ∈ {idle, sleeping} (always)
 */
export function computeBehaviorPhase(
  ballState: ConciergeBallState,
  idleElapsedMs: number,
  behaviorEnabled: boolean,
): BehaviorPhase {
  // Config kill-switch
  if (!behaviorEnabled) return 'business';

  // Business states always take priority (zero-delay interrupt)
  const isIdle = ballState === 'idle' || ballState === 'sleeping';
  if (!isIdle) return 'business';

  // Hysteresis: must idle for IDLE_ENTRY_DELAY_MS before autonomous
  if (idleElapsedMs < IDLE_ENTRY_DELAY_MS) return 'idle-countdown';

  return 'autonomous';
}

// ---------------------------------------------------------------------------
// Event behavior computation (AC-E4-3, spec §B EventBehavior — independent of phase)
// ---------------------------------------------------------------------------

/** Input for event-driven behavior computation (spec §B EventBehavior). */
export interface EventBehaviorInput {
  /** timestamp of last incoming message (0 = none) */
  lastMessageTimestamp: number;
  /** timestamp of last bounce animation start (0 = never) */
  lastBounceTimestamp: number;
  /** current timestamp for duration calculations */
  currentTimestamp: number;
}

/**
 * Pure event behavior computation (spec §B EventBehavior — independent of phase).
 *
 * Handles message bounce (消息惊起, AC-E4-3). Runs independently of
 * AmbientBehavior and is NOT gated behind autonomous phase entry.
 *
 * @returns Visual output if an event behavior is active, null otherwise.
 */
export function computeEventBehavior(input: EventBehaviorInput): Omit<PetBehaviorOutput, 'isAutonomousActive'> | null {
  if (input.lastMessageTimestamp <= 0) return null;

  const timeSinceMessage = input.currentTimestamp - input.lastMessageTimestamp;
  const timeSinceLastBounce =
    input.lastBounceTimestamp !== 0 ? input.currentTimestamp - input.lastBounceTimestamp : Infinity;

  // Continue active bounce: keep jumping for full duration once started
  if (timeSinceLastBounce < MESSAGE_BOUNCE_DURATION_MS) {
    return {
      visualState: 'jumping' as CodexPetState,
      overlay: null,
      positionDelta: null,
    };
  }

  // Start new bounce: message arrived recently AND cooldown since last bounce passed
  if (
    timeSinceMessage >= 0 &&
    timeSinceMessage < MESSAGE_BOUNCE_DURATION_MS &&
    timeSinceLastBounce >= MESSAGE_BOUNCE_COOLDOWN_MS
  ) {
    return {
      visualState: 'jumping' as CodexPetState,
      overlay: null,
      positionDelta: null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ambient behavior computation (AC-E4-4, AC-E4-5)
// ---------------------------------------------------------------------------

/** Input bag for ambient behavior computation — all timestamps/distances from hook. */
export interface AmbientBehaviorInput {
  /** ms since autonomous phase began */
  autonomousElapsedMs: number;
  /** current timestamp for duration calculations */
  currentTimestamp?: number;
  /** ms since last user input (mouse/keyboard) */
  userIdleSinceMs: number;
  /** timestamp of last browser user activity; when present, overrides userIdleSinceMs */
  lastUserActivityTimestamp?: number;
  /** distance from mouse cursor to ball center (px) */
  mouseDistance: number;
  /** timestamp when last walk ended (0 = never) */
  lastWalkEndTimestamp: number;
  /** deterministic seed [0,1) for walk direction — passed from outside for testability */
  walkSeed: number;
  /** viewport dimensions */
  viewport: { width: number; height: number };
  /** current ball position */
  ballPosition: { x: number; y: number };
}

/**
 * Pure ambient behavior computation.
 *
 * Priority: 空闲提醒 > 自主溜達 (AC-E4-6 "三不" safety).
 * Message bounce (消息惊起) is handled by computeEventBehavior (spec §B EventBehavior).
 *
 * @returns PetBehaviorOutput without isAutonomousActive (caller sets that)
 */
export function computeAmbientBehavior(input: AmbientBehaviorInput): Omit<PetBehaviorOutput, 'isAutonomousActive'> {
  const wouldShowIdleReminder = input.userIdleSinceMs >= IDLE_REMINDER_DELAY_MS;
  const userIdleSinceMs =
    input.currentTimestamp != null && input.lastUserActivityTimestamp != null
      ? Math.max(0, input.currentTimestamp - input.lastUserActivityTimestamp)
      : input.userIdleSinceMs;
  const userActivityWokeIdleReminder = wouldShowIdleReminder && userIdleSinceMs < IDLE_REMINDER_DELAY_MS;

  // --- Priority 1: 空闲提醒 (AC-E4-5) ---
  if (userIdleSinceMs >= IDLE_REMINDER_DELAY_MS) {
    // Mouse proximity wakes the cat
    if (input.mouseDistance < IDLE_REMINDER_PROXIMITY_PX) {
      return {
        visualState: 'idle' as CodexPetState,
        overlay: null,
        positionDelta: null,
      };
    }
    return {
      visualState: 'waving' as CodexPetState,
      overlay: '\u{1F4A4}', // 💤
      positionDelta: null,
    };
  }

  if (userActivityWokeIdleReminder) {
    return {
      visualState: 'idle' as CodexPetState,
      overlay: null,
      positionDelta: null,
    };
  }

  // --- Priority 2: 自主溜達 (AC-E4-4) ---
  const walkDelta = computeWalkDelta(input);
  if (walkDelta) {
    return {
      visualState: 'running' as CodexPetState,
      overlay: null,
      positionDelta: walkDelta,
    };
  }

  // --- Default: idle ---
  return {
    visualState: 'idle' as CodexPetState,
    overlay: null,
    positionDelta: null,
  };
}

// ---------------------------------------------------------------------------
// Walk computation (AC-E4-4 + AC-E4-6 "三不")
// ---------------------------------------------------------------------------

/** Step distance for random walk (px). */
const WALK_STEP_PX = 40;

/**
 * Compute walk delta with center avoidance (AC-E4-6: no central obstruction).
 *
 * Returns null if walk cooldown hasn't elapsed or seed doesn't trigger walk.
 */
function computeWalkDelta(input: AmbientBehaviorInput): { dx: number; dy: number } | null {
  const now = input.currentTimestamp ?? input.autonomousElapsedMs;

  // Cooldown check (max 1 walk per 2min)
  if (input.lastWalkEndTimestamp !== 0) {
    const timeSinceLastWalk = now - input.lastWalkEndTimestamp;
    if (timeSinceLastWalk < WALK_COOLDOWN_MS) return null;
  }

  // Seed threshold — only walk when seed < 0.3 (probabilistic gating)
  if (input.walkSeed >= 0.3) return null;

  // Compute direction based on seed (8 cardinal + ordinal directions)
  const angle = input.walkSeed * ((2 * Math.PI) / 0.3); // map [0,0.3) → [0,2π)
  let dx = Math.round(Math.cos(angle) * WALK_STEP_PX);
  let dy = Math.round(Math.sin(angle) * WALK_STEP_PX);

  // Apply center avoidance (AC-E4-6: avoid center 40%)
  const newX = input.ballPosition.x + dx;
  const newY = input.ballPosition.y + dy;
  const centerLeft = input.viewport.width * 0.3;
  const centerRight = input.viewport.width * 0.7;
  const centerTop = input.viewport.height * 0.3;
  const centerBottom = input.viewport.height * 0.7;

  const wouldBeInCenter = newX >= centerLeft && newX <= centerRight && newY >= centerTop && newY <= centerBottom;

  if (wouldBeInCenter) {
    // Reverse direction to move away from center
    dx = -dx;
    dy = -dy;

    // If reversed position is still in center (ball IS in center), push to nearest edge
    const reversedX = input.ballPosition.x + dx;
    const reversedY = input.ballPosition.y + dy;
    const stillInCenter =
      reversedX >= centerLeft && reversedX <= centerRight && reversedY >= centerTop && reversedY <= centerBottom;

    if (stillInCenter) {
      // Push toward nearest edge
      const distToLeft = input.ballPosition.x - centerLeft;
      const distToRight = centerRight - input.ballPosition.x;
      const distToTop = input.ballPosition.y - centerTop;
      const distToBottom = centerBottom - input.ballPosition.y;
      const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);

      if (minDist === distToLeft) {
        dx = -(WALK_STEP_PX + distToLeft);
        dy = 0;
      } else if (minDist === distToRight) {
        dx = WALK_STEP_PX + distToRight;
        dy = 0;
      } else if (minDist === distToTop) {
        dx = 0;
        dy = -(WALK_STEP_PX + distToTop);
      } else {
        dx = 0;
        dy = WALK_STEP_PX + distToBottom;
      }
    }
  }

  // Viewport boundary clamping — don't walk off-screen
  const finalX = Math.max(0, Math.min(input.viewport.width, input.ballPosition.x + dx));
  const finalY = Math.max(0, Math.min(input.viewport.height, input.ballPosition.y + dy));
  dx = finalX - input.ballPosition.x;
  dy = finalY - input.ballPosition.y;

  // If clamping zeroed the delta, skip the walk
  if (dx === 0 && dy === 0) return null;

  return { dx, dy };
}
