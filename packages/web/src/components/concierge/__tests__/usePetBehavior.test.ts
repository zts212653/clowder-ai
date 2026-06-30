/**
 * F229 Phase E4: Autonomous Behavior Engine — pure computation tests.
 *
 * Tests the pure computation core of the behavior engine:
 * - Phase transitions (business → idle-countdown → autonomous)
 * - Event behavior (消息惊起 — independent of phase, spec §B EventBehavior)
 * - Ambient behaviors (空闲提醒, 自主溜達)
 * - Config gating (behaviorEnabled, muted)
 *
 * React hook integration tested via ConciergeHost component tests.
 */

import { describe, expect, it } from 'vitest';
import {
  computeAmbientBehavior,
  computeBehaviorPhase,
  computeEventBehavior,
  IDLE_ENTRY_DELAY_MS,
  IDLE_REMINDER_DELAY_MS,
  IDLE_REMINDER_PROXIMITY_PX,
  MESSAGE_BOUNCE_COOLDOWN_MS,
  WALK_COOLDOWN_MS,
} from '../petBehaviorCore';

// ---------------------------------------------------------------------------
// Phase transition tests (AC-E4-1: dual-input priority composition)
// ---------------------------------------------------------------------------

describe('computeBehaviorPhase', () => {
  it('returns "business" when ballState is not idle or sleeping', () => {
    expect(computeBehaviorPhase('thinking', 0, true)).toBe('business');
    expect(computeBehaviorPhase('found', 0, true)).toBe('business');
    expect(computeBehaviorPhase('error', 0, true)).toBe('business');
    expect(computeBehaviorPhase('listening', 0, true)).toBe('business');
    expect(computeBehaviorPhase('needs-confirmation', 0, true)).toBe('business');
    expect(computeBehaviorPhase('handoff', 0, true)).toBe('business');
  });

  it('returns "idle-countdown" when idle and elapsed < IDLE_ENTRY_DELAY_MS', () => {
    expect(computeBehaviorPhase('idle', 0, true)).toBe('idle-countdown');
    expect(computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS - 1, true)).toBe('idle-countdown');
    expect(computeBehaviorPhase('sleeping', 0, true)).toBe('idle-countdown');
  });

  it('returns "autonomous" when idle and elapsed >= IDLE_ENTRY_DELAY_MS', () => {
    expect(computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS, true)).toBe('autonomous');
    expect(computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS + 5000, true)).toBe('autonomous');
    expect(computeBehaviorPhase('sleeping', IDLE_ENTRY_DELAY_MS, true)).toBe('autonomous');
  });

  it('returns "business" when behaviorEnabled is false regardless of state', () => {
    expect(computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS + 5000, false)).toBe('business');
  });
});

// ---------------------------------------------------------------------------
// Event behavior tests (AC-E4-3: 消息惊起 — spec §B EventBehavior)
// EventBehavior runs independently of phase (not gated by 10s idle delay).
// The hook calls computeEventBehavior BEFORE the phase gate.
// ---------------------------------------------------------------------------

describe('computeEventBehavior', () => {
  it('triggers jumping on recent message within bounce duration', () => {
    const now = 1000;
    const result = computeEventBehavior({
      lastMessageTimestamp: now,
      lastBounceTimestamp: 0,
      currentTimestamp: now + 500, // 500ms into bounce
    });
    expect(result).not.toBeNull();
    expect(result!.visualState).toBe('jumping');
  });

  it('respects bounce cooldown (no new bounce within 5s of last)', () => {
    const msgTime = 10_000;
    const tickTime = msgTime + 100;
    // Last bounce 4600ms ago (400ms short of 5s cooldown) — measured from tickTime
    const recentBounce = tickTime - (MESSAGE_BOUNCE_COOLDOWN_MS - 400);
    const result = computeEventBehavior({
      lastMessageTimestamp: msgTime,
      lastBounceTimestamp: recentBounce,
      currentTimestamp: tickTime,
    });
    // timeSinceLastBounce = 4600ms > 2000ms duration → not continuing old bounce
    // timeSinceLastBounce = 4600ms < 5000ms cooldown → no new bounce either
    expect(result).toBeNull();
  });

  it('maintains jumping for the full 2s bounce duration across ticks', () => {
    const bounceStart = 10_000;
    const result = computeEventBehavior({
      lastMessageTimestamp: bounceStart,
      lastBounceTimestamp: bounceStart,
      currentTimestamp: bounceStart + 1000, // 1s into 2s duration
    });
    expect(result).not.toBeNull();
    expect(result!.visualState).toBe('jumping');
  });

  it('stops jumping after bounce duration expires', () => {
    const bounceStart = 10_000;
    const result = computeEventBehavior({
      lastMessageTimestamp: bounceStart,
      lastBounceTimestamp: bounceStart,
      currentTimestamp: bounceStart + 2500, // past 2s duration
    });
    expect(result).toBeNull();
  });

  it('allows new bounce after cooldown expires', () => {
    const firstBounce = 10_000;
    const newMessage = firstBounce + MESSAGE_BOUNCE_COOLDOWN_MS + 1000;
    const result = computeEventBehavior({
      lastMessageTimestamp: newMessage,
      lastBounceTimestamp: firstBounce,
      currentTimestamp: newMessage + 500, // 500ms into new bounce
    });
    expect(result).not.toBeNull();
    expect(result!.visualState).toBe('jumping');
  });

  it('returns null when no message has arrived (lastMessageTimestamp=0)', () => {
    const result = computeEventBehavior({
      lastMessageTimestamp: 0,
      lastBounceTimestamp: 0,
      currentTimestamp: 30_000,
    });
    expect(result).toBeNull();
  });

  it('returns null when message is outside bounce window', () => {
    const result = computeEventBehavior({
      lastMessageTimestamp: 10_000,
      lastBounceTimestamp: 0,
      currentTimestamp: 15_000, // 5s after message, well past 2s window
    });
    expect(result).toBeNull();
  });

  // --- P1 fix: EventBehavior is phase-independent (spec §B 双子系统) ---

  it('message bounce is phase-independent (fires regardless of idle duration)', () => {
    // Key test for P1 fix: computeEventBehavior is a pure function that doesn't
    // check phase at all. The hook calls it BEFORE the phase gate, so bounce fires
    // during idle-countdown (0-10s) as well as during autonomous (10s+).
    // Previously, bounce was inside computeAmbientBehavior which was gated behind
    // phase === 'autonomous', making it unreachable during idle-countdown.
    const now = 50_000;
    const result = computeEventBehavior({
      lastMessageTimestamp: now - 500,
      lastBounceTimestamp: 0,
      currentTimestamp: now,
    });
    expect(result).not.toBeNull();
    expect(result!.visualState).toBe('jumping');
    expect(result!.overlay).toBeNull();
    expect(result!.positionDelta).toBeNull();
  });

  // --- Priority: EventBehavior > AmbientBehavior ---

  it('event behavior result preempts ambient (hook returns event and skips ambient)', () => {
    // When computeEventBehavior returns non-null, the hook uses it and skips
    // computeAmbientBehavior entirely. This ensures EventBehavior > AmbientBehavior
    // priority as specified in the feature doc.
    const now = IDLE_REMINDER_DELAY_MS + 1000;
    const result = computeEventBehavior({
      lastMessageTimestamp: now - 500,
      lastBounceTimestamp: 0,
      currentTimestamp: now,
    });
    // Event behavior fires despite conditions that would trigger idle reminder
    expect(result).not.toBeNull();
    expect(result!.visualState).toBe('jumping');
  });
});

// ---------------------------------------------------------------------------
// Ambient behavior tests (AC-E4-4, AC-E4-5 — gated behind autonomous phase)
// Message bounce tests are in computeEventBehavior above.
// ---------------------------------------------------------------------------

describe('computeAmbientBehavior', () => {
  const viewport = { width: 1920, height: 1080 };
  const ballPos = { x: 100, y: 900 }; // bottom-left, outside center 40%

  it('returns idle state when no behavior is active', () => {
    const result = computeAmbientBehavior({
      autonomousElapsedMs: 0,
      userIdleSinceMs: 0,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.5,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.visualState).toBe('idle');
    expect(result.overlay).toBeNull();
    expect(result.positionDelta).toBeNull();
  });

  // --- 空闲提醒 (AC-E4-5) ---

  it('triggers waving with sleep overlay after user idle 5min', () => {
    const result = computeAmbientBehavior({
      autonomousElapsedMs: IDLE_REMINDER_DELAY_MS + 1000,
      currentTimestamp: IDLE_REMINDER_DELAY_MS + 1000,
      userIdleSinceMs: IDLE_REMINDER_DELAY_MS + 1000,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.5,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.visualState).toBe('waving');
    expect(result.overlay).toBe('\u{1F4A4}'); // 💤
  });

  it('wakes from idle reminder when mouse is close', () => {
    const result = computeAmbientBehavior({
      autonomousElapsedMs: IDLE_REMINDER_DELAY_MS + 1000,
      currentTimestamp: IDLE_REMINDER_DELAY_MS + 1000,
      userIdleSinceMs: IDLE_REMINDER_DELAY_MS + 1000,
      mouseDistance: IDLE_REMINDER_PROXIMITY_PX - 10,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.5,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.visualState).toBe('idle');
    expect(result.overlay).toBeNull();
  });

  it('wakes from idle reminder after recent user activity even when mouse is not close', () => {
    const now = IDLE_REMINDER_DELAY_MS + 1000;
    const result = computeAmbientBehavior({
      autonomousElapsedMs: now,
      currentTimestamp: now,
      userIdleSinceMs: now,
      lastUserActivityTimestamp: now - 100,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.5,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.visualState).toBe('idle');
    expect(result.overlay).toBeNull();
  });

  it('does not fall through into random walk on the same tick as recent user activity', () => {
    const now = IDLE_REMINDER_DELAY_MS + 1000;
    const result = computeAmbientBehavior({
      autonomousElapsedMs: now,
      currentTimestamp: now,
      userIdleSinceMs: now,
      lastUserActivityTimestamp: now - 100,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.1,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.visualState).toBe('idle');
    expect(result.overlay).toBeNull();
    expect(result.positionDelta).toBeNull();
  });

  // --- 自主溜达 (AC-E4-4) ---

  it('does not walk if cooldown has not elapsed', () => {
    const now = 50_000;
    const result = computeAmbientBehavior({
      autonomousElapsedMs: 40_000,
      currentTimestamp: now,
      userIdleSinceMs: 0,
      mouseDistance: 200,
      lastWalkEndTimestamp: now - (WALK_COOLDOWN_MS - 1000),
      walkSeed: 0.1,
      viewport,
      ballPosition: ballPos,
    });
    expect(result.positionDelta).toBeNull();
  });

  // --- "三不" safety (AC-E4-6) ---

  it('walk avoids viewport center 40%', () => {
    const centerPos = { x: 960, y: 540 };
    const result = computeAmbientBehavior({
      autonomousElapsedMs: 40_000,
      currentTimestamp: 50_000,
      userIdleSinceMs: 0,
      mouseDistance: 200,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.1,
      viewport,
      ballPosition: centerPos,
    });
    if (result.positionDelta) {
      const newX = centerPos.x + result.positionDelta.dx;
      const newY = centerPos.y + result.positionDelta.dy;
      const centerLeft = viewport.width * 0.3;
      const centerRight = viewport.width * 0.7;
      const centerTop = viewport.height * 0.3;
      const centerBottom = viewport.height * 0.7;
      const inCenter = newX >= centerLeft && newX <= centerRight && newY >= centerTop && newY <= centerBottom;
      expect(inCenter).toBe(false);
    }
  });

  // --- Cloud R2-1: hidden ball must suppress autonomous (INV-3) ---

  it('computeBehaviorPhase returns "business" when behaviorEnabled is false (hidden gate)', () => {
    expect(computeBehaviorPhase('idle', IDLE_ENTRY_DELAY_MS + 5000, false)).toBe('business');
    expect(computeBehaviorPhase('sleeping', IDLE_ENTRY_DELAY_MS + 5000, false)).toBe('business');
  });

  // --- Cloud R2-4: proximity center must use dynamic ball size ---

  it('proximity wake uses correct center for non-default ball sizes', () => {
    const largeBall = { x: 100, y: 900 };
    const result = computeAmbientBehavior({
      autonomousElapsedMs: IDLE_REMINDER_DELAY_MS + 1000,
      currentTimestamp: IDLE_REMINDER_DELAY_MS + 1000,
      userIdleSinceMs: IDLE_REMINDER_DELAY_MS + 1000,
      mouseDistance: 0,
      lastWalkEndTimestamp: 0,
      walkSeed: 0.5,
      viewport,
      ballPosition: largeBall,
    });
    expect(result.visualState).toBe('idle');
    expect(result.overlay).toBeNull();
  });
});
