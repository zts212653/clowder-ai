/**
 * F252 Phase E PR E-2 — Bullet Time Easing Function Tests
 *
 * Tests the pure easing function that computes speed factor
 * during bullet time (pass-ball slowdown with smooth transitions).
 *
 * AC-E4: 传球事件触发平滑降速 100x→1x→0.5x，降速后自动回升
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEL_MS,
  BULLET_TIME_TOTAL_MS,
  bulletTimeSpeedFactor,
  DECEL_MS,
  HOLD_MS,
  MIN_SPEED_FACTOR,
} from '../bullet-time';

describe('F252 bullet time easing — bulletTimeSpeedFactor', () => {
  // ---------------------------------------------------------------------------
  // Phase boundaries
  // ---------------------------------------------------------------------------

  it('returns 1.0 at progressMs=0 (start)', () => {
    expect(bulletTimeSpeedFactor(0)).toBeCloseTo(1.0);
  });

  it('returns MIN_SPEED_FACTOR at end of deceleration phase', () => {
    expect(bulletTimeSpeedFactor(DECEL_MS)).toBeCloseTo(MIN_SPEED_FACTOR, 1);
  });

  it('holds at MIN_SPEED_FACTOR at midpoint of hold phase', () => {
    expect(bulletTimeSpeedFactor(DECEL_MS + HOLD_MS / 2)).toBeCloseTo(MIN_SPEED_FACTOR, 1);
  });

  it('holds at MIN_SPEED_FACTOR at end of hold phase', () => {
    expect(bulletTimeSpeedFactor(DECEL_MS + HOLD_MS)).toBeCloseTo(MIN_SPEED_FACTOR, 1);
  });

  it('returns 1.0 at end of total duration', () => {
    expect(bulletTimeSpeedFactor(BULLET_TIME_TOTAL_MS)).toBeCloseTo(1.0);
  });

  // ---------------------------------------------------------------------------
  // Phase constants sanity
  // ---------------------------------------------------------------------------

  it('has TOTAL = DECEL + HOLD + ACCEL', () => {
    expect(BULLET_TIME_TOTAL_MS).toBe(DECEL_MS + HOLD_MS + ACCEL_MS);
  });

  it('MIN_SPEED_FACTOR is positive and less than 1', () => {
    expect(MIN_SPEED_FACTOR).toBeGreaterThan(0);
    expect(MIN_SPEED_FACTOR).toBeLessThan(1);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('returns 1.0 for values beyond total (overshoot)', () => {
    expect(bulletTimeSpeedFactor(BULLET_TIME_TOTAL_MS + 500)).toBeCloseTo(1.0);
    expect(bulletTimeSpeedFactor(BULLET_TIME_TOTAL_MS + 10_000)).toBeCloseTo(1.0);
  });

  it('returns 1.0 for negative progressMs', () => {
    expect(bulletTimeSpeedFactor(-100)).toBe(1.0);
    expect(bulletTimeSpeedFactor(-1)).toBe(1.0);
  });

  // ---------------------------------------------------------------------------
  // INV-3: always in [MIN_SPEED_FACTOR, 1.0] — boundary sweep
  // ---------------------------------------------------------------------------

  it('INV-3: speed factor always in [MIN_SPEED_FACTOR, 1.0] (full sweep)', () => {
    // Sweep at 5ms granularity across extended range
    for (let ms = -100; ms <= BULLET_TIME_TOTAL_MS + 200; ms += 5) {
      const f = bulletTimeSpeedFactor(ms);
      expect(f).toBeGreaterThanOrEqual(MIN_SPEED_FACTOR);
      expect(f).toBeLessThanOrEqual(1.0);
    }
  });

  // ---------------------------------------------------------------------------
  // Monotonicity within phases
  // ---------------------------------------------------------------------------

  it('deceleration phase is monotonically decreasing', () => {
    let prev = bulletTimeSpeedFactor(0);
    for (let ms = 10; ms <= DECEL_MS; ms += 10) {
      const curr = bulletTimeSpeedFactor(ms);
      expect(curr).toBeLessThanOrEqual(prev + 1e-9); // allow tiny float noise
      prev = curr;
    }
  });

  it('acceleration phase is monotonically increasing', () => {
    const accelStart = DECEL_MS + HOLD_MS;
    let prev = bulletTimeSpeedFactor(accelStart);
    for (let ms = accelStart + 10; ms <= BULLET_TIME_TOTAL_MS; ms += 10) {
      const curr = bulletTimeSpeedFactor(ms);
      expect(curr).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = curr;
    }
  });

  // ---------------------------------------------------------------------------
  // Mid-phase values (smoke check)
  // ---------------------------------------------------------------------------

  it('mid-deceleration is between 1.0 and MIN_SPEED_FACTOR', () => {
    const mid = bulletTimeSpeedFactor(DECEL_MS / 2);
    expect(mid).toBeGreaterThan(MIN_SPEED_FACTOR);
    expect(mid).toBeLessThan(1.0);
  });

  it('mid-acceleration is between MIN_SPEED_FACTOR and 1.0', () => {
    const mid = bulletTimeSpeedFactor(DECEL_MS + HOLD_MS + ACCEL_MS / 2);
    expect(mid).toBeGreaterThan(MIN_SPEED_FACTOR);
    expect(mid).toBeLessThan(1.0);
  });
});
