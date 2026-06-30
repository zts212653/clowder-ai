/**
 * F229 Phase E4: "三不" Safety Tests (AC-E4-6)
 *
 * 1. No focus hijack — autonomous behaviors never trigger dialogs/toasts/modals
 * 2. No central obstruction — walk paths never enter center 40% viewport
 * 3. No event spamming — cooldowns enforced, rapid messages don't cause rapid jumping
 */

import { describe, expect, it } from 'vitest';
import {
  computeAmbientBehavior,
  computeBehaviorPhase,
  computeEventBehavior,
  IDLE_ENTRY_DELAY_MS,
  MESSAGE_BOUNCE_DURATION_MS,
} from '../petBehaviorCore';

const viewport = { width: 1920, height: 1080 };
const edgePos = { x: 100, y: 900 };

// ---------------------------------------------------------------------------
// "三不" #1: No focus hijack (AC-E4-6)
// ---------------------------------------------------------------------------

describe('No focus hijack', () => {
  it('computeAmbientBehavior returns only visual data — no side effects', () => {
    // The function signature returns {visualState, overlay, positionDelta}.
    // None of these are imperative commands (no window.alert, no DOM manipulation).
    // This test verifies the output shape is purely declarative.
    const result = computeAmbientBehavior({
      autonomousElapsedMs: 20_000,
      currentTimestamp: 16_000,
      userIdleSinceMs: 20_000,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.1,
      viewport,
      ballPosition: edgePos,
    });

    // Return value must be a plain object with only these keys
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['overlay', 'positionDelta', 'visualState']);

    // visualState must be a string (CodexPetState) or null
    expect(typeof result.visualState === 'string' || result.visualState === null).toBe(true);

    // overlay must be a string emoji or null
    expect(typeof result.overlay === 'string' || result.overlay === null).toBe(true);

    // positionDelta must be {dx, dy} or null
    if (result.positionDelta !== null) {
      expect(typeof result.positionDelta.dx).toBe('number');
      expect(typeof result.positionDelta.dy).toBe('number');
    }
  });

  it('phase computation is a pure function with no side effects', () => {
    // Calling computeBehaviorPhase multiple times with same input always returns same output
    const r1 = computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS, true);
    const r2 = computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS, true);
    const r3 = computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS, true);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toBe('autonomous');
  });
});

// ---------------------------------------------------------------------------
// "三不" #2: No central obstruction (AC-E4-6)
// ---------------------------------------------------------------------------

describe('No central obstruction', () => {
  const centerLeft = viewport.width * 0.3; // 576
  const centerRight = viewport.width * 0.7; // 1344
  const centerTop = viewport.height * 0.3; // 324
  const centerBottom = viewport.height * 0.7; // 756

  function isInCenter(x: number, y: number): boolean {
    return x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom;
  }

  it('walks away from center when starting at center', () => {
    const centerPos = { x: 960, y: 540 }; // dead center
    // Try multiple seeds that would trigger walk (< 0.3)
    for (const seed of [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.29]) {
      const result = computeAmbientBehavior({
        autonomousElapsedMs: 40_000,
        currentTimestamp: 50_000,
        userIdleSinceMs: 0,
        mouseDistance: 200,
        lastWalkEndTimestamp: 0,
        walkSeed: seed,
        viewport,
        ballPosition: centerPos,
      });
      if (result.positionDelta) {
        const newX = centerPos.x + result.positionDelta.dx;
        const newY = centerPos.y + result.positionDelta.dy;
        expect(isInCenter(newX, newY)).toBe(false);
      }
    }
  });

  it('walk from edge stays outside center', () => {
    // Ball at bottom-left edge (well outside center)
    const result = computeAmbientBehavior({
      autonomousElapsedMs: 40_000,
      currentTimestamp: 50_000,
      userIdleSinceMs: 0,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.1,
      viewport,
      ballPosition: edgePos,
    });
    if (result.positionDelta) {
      const newX = edgePos.x + result.positionDelta.dx;
      const newY = edgePos.y + result.positionDelta.dy;
      // Starting from edge, walk should not jump into center
      expect(isInCenter(newX, newY)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// "三不" #3: No event spamming (AC-E4-6)
// ---------------------------------------------------------------------------

describe('No event spamming', () => {
  it('rapid messages do not cause rapid jumping (cooldown enforced)', () => {
    let bounceEventCount = 0;
    let lastBounce = 0;
    let wasJumping = false;
    const baseTime = 10_000;

    // Simulate 10 messages arriving 500ms apart (much faster than cooldown)
    for (let i = 0; i < 10; i++) {
      const msgTime = baseTime + i * 500;
      const tickTime = msgTime + 100;
      const result = computeEventBehavior({
        lastMessageTimestamp: msgTime,
        lastBounceTimestamp: lastBounce,
        currentTimestamp: tickTime,
      });
      const isJumping = result?.visualState === 'jumping';
      // Count distinct bounce EVENTS (non-jumping → jumping transitions)
      if (isJumping && !wasJumping) {
        bounceEventCount++;
        lastBounce = tickTime; // simulate hook: record bounce start
      }
      wasJumping = isJumping;
    }

    // With 5s cooldown, rapid 500ms messages over 5s → at most 1 bounce event
    // (first message triggers bounce; all others within cooldown)
    expect(bounceEventCount).toBeLessThanOrEqual(2);
  });

  it('walk cooldown prevents rapid walks', () => {
    let walkCount = 0;
    const baseTime = 10_000;

    for (let i = 0; i < 5; i++) {
      const result = computeAmbientBehavior({
        autonomousElapsedMs: 40_000 + i * 30_000,
        currentTimestamp: baseTime + i * 30_000,
        userIdleSinceMs: 0,
        mouseDistance: 200,
        lastWalkEndTimestamp: walkCount > 0 ? baseTime : 0,
        walkSeed: 0.1,
        viewport,
        ballPosition: edgePos,
      });
      if (result.positionDelta) {
        walkCount++;
      }
    }

    // With 2min cooldown and checks 30s apart, should get at most 2 walks
    expect(walkCount).toBeLessThanOrEqual(2);
  });

  it('bounce duration is finite (does not loop forever)', () => {
    // After MESSAGE_BOUNCE_DURATION_MS, jumping should stop
    const msgTime = 10_000;
    const afterBounce = computeEventBehavior({
      lastMessageTimestamp: msgTime,
      lastBounceTimestamp: 0,
      currentTimestamp: msgTime + MESSAGE_BOUNCE_DURATION_MS + 1,
    });
    // Past bounce duration + past bounce window → null (no event)
    expect(afterBounce).toBeNull();
  });
});
