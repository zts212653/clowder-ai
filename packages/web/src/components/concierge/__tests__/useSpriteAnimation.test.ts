/**
 * F229 Phase E1: Sprite animation logic tests.
 *
 * Tests the pure computation helpers used by useSpriteAnimation:
 * - backgroundPosition calculation
 * - frame advancement (next frame index)
 * - config change detection (reset on state transition)
 *
 * The React hook itself is a thin wrapper around these — tested via
 * integration in ConciergeBall component tests.
 */

import { describe, expect, it } from 'vitest';
import {
  computeBackgroundPosition,
  computeConfigKey,
  computeScaledBackgroundPosition,
  nextFrame,
} from '../useSpriteAnimation';

describe('computeBackgroundPosition', () => {
  it('frame 0, row 0 → 0px 0px', () => {
    expect(computeBackgroundPosition(0, 0, 192, 208)).toBe('0px 0px');
  });

  it('frame 1, row 0 → -192px 0px', () => {
    expect(computeBackgroundPosition(1, 0, 192, 208)).toBe('-192px 0px');
  });

  it('frame 3, row 0 → -576px 0px', () => {
    expect(computeBackgroundPosition(3, 0, 192, 208)).toBe('-576px 0px');
  });

  it('frame 0, row 1 → 0px -208px', () => {
    expect(computeBackgroundPosition(0, 1, 192, 208)).toBe('0px -208px');
  });

  it('frame 2, row 5 → -384px -1040px', () => {
    // 2 * 192 = 384, 5 * 208 = 1040
    expect(computeBackgroundPosition(2, 5, 192, 208)).toBe('-384px -1040px');
  });

  it('frame 7, row 8 (last row) → -1344px -1664px', () => {
    // 7 * 192 = 1344, 8 * 208 = 1664
    expect(computeBackgroundPosition(7, 8, 192, 208)).toBe('-1344px -1664px');
  });
});

describe('nextFrame', () => {
  it('advances from 0 to 1', () => {
    expect(nextFrame(0, 6)).toBe(1);
  });

  it('advances from mid frame', () => {
    expect(nextFrame(3, 8)).toBe(4);
  });

  it('wraps around from last frame to 0', () => {
    expect(nextFrame(5, 6)).toBe(0); // 6 frames: 0-5, next after 5 = 0
  });

  it('wraps around for 8-frame animation', () => {
    expect(nextFrame(7, 8)).toBe(0);
  });

  it('single frame stays at 0', () => {
    expect(nextFrame(0, 1)).toBe(0);
  });
});

describe('computeConfigKey', () => {
  it('produces stable key for same config', () => {
    const key1 = computeConfigKey(0, 6);
    const key2 = computeConfigKey(0, 6);
    expect(key1).toBe(key2);
  });

  it('produces different key for different row', () => {
    const key1 = computeConfigKey(0, 6);
    const key2 = computeConfigKey(1, 6);
    expect(key1).not.toBe(key2);
  });

  it('produces different key for different frameCount', () => {
    const key1 = computeConfigKey(0, 6);
    const key2 = computeConfigKey(0, 8);
    expect(key1).not.toBe(key2);
  });
});

describe('computeScaledBackgroundPosition', () => {
  // Display size for yanyan-codex: 192×208 cells → 59×64 display (height-fit)
  const DW = 59; // Math.round(64 * 192 / 208)
  const DH = 64;

  it('frame 0, row 0 → 0px 0px', () => {
    expect(computeScaledBackgroundPosition(0, 0, DW, DH)).toBe('0px 0px');
  });

  it('frame 1, row 0 → -59px 0px', () => {
    expect(computeScaledBackgroundPosition(1, 0, DW, DH)).toBe('-59px 0px');
  });

  it('frame 7 (last of 8-col) → -413px (NOT -414px — the rounding bug)', () => {
    // This is the exact case that exposed the P2:
    // Old code: Math.round(-(7 * 192) * (64/208)) = Math.round(-413.538) = -414
    // Correct:  -(7 * 59) = -413
    expect(computeScaledBackgroundPosition(7, 0, DW, DH)).toBe('-413px 0px');
  });

  it('row 8 (last row) → Y = -512px', () => {
    expect(computeScaledBackgroundPosition(0, 8, DW, DH)).toBe('0px -512px');
  });

  it('frame 7, row 5 (failed state last frame) → -413px -320px', () => {
    // 7 * 59 = 413, 5 * 64 = 320
    expect(computeScaledBackgroundPosition(7, 5, DW, DH)).toBe('-413px -320px');
  });
});
