/**
 * F229 E3: ConciergeConfig ballSize field tests
 *
 * Validates that:
 * - ballSize field exists on ConciergeConfig type (via defaults)
 * - Default ballSize is 72 (legacy BALL_SIZE constant)
 * - MIN/MAX size constants are exported and within sprite resolution bounds
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_SIZE_DEFAULT,
  BALL_SIZE_MAX,
  BALL_SIZE_MIN,
  CONCIERGE_CONFIG_DEFAULTS,
  clampBallSize,
} from '../src/types/concierge.js';

describe('ConciergeConfig ballSize (E3)', () => {
  it('CONCIERGE_CONFIG_DEFAULTS includes ballSize with value 72', () => {
    expect(CONCIERGE_CONFIG_DEFAULTS).toHaveProperty('ballSize');
    expect(CONCIERGE_CONFIG_DEFAULTS.ballSize).toBe(72);
  });

  it('exports BALL_SIZE_MIN = 48', () => {
    expect(BALL_SIZE_MIN).toBe(48);
  });

  it('exports BALL_SIZE_MAX = 192', () => {
    expect(BALL_SIZE_MAX).toBe(192);
  });

  it('exports BALL_SIZE_DEFAULT = 72', () => {
    expect(BALL_SIZE_DEFAULT).toBe(72);
  });

  describe('clampBallSize()', () => {
    it('returns default when input is undefined', () => {
      expect(clampBallSize(undefined)).toBe(BALL_SIZE_DEFAULT);
    });

    it('returns default when input is null', () => {
      expect(clampBallSize(null)).toBe(BALL_SIZE_DEFAULT);
    });

    it('clamps below MIN to MIN', () => {
      expect(clampBallSize(10)).toBe(BALL_SIZE_MIN);
    });

    it('clamps above MAX to MAX', () => {
      expect(clampBallSize(500)).toBe(BALL_SIZE_MAX);
    });

    it('passes through valid values unchanged', () => {
      expect(clampBallSize(100)).toBe(100);
    });

    it('handles MIN boundary exactly', () => {
      expect(clampBallSize(BALL_SIZE_MIN)).toBe(BALL_SIZE_MIN);
    });

    it('handles MAX boundary exactly', () => {
      expect(clampBallSize(BALL_SIZE_MAX)).toBe(BALL_SIZE_MAX);
    });

    it('rounds to nearest integer', () => {
      expect(clampBallSize(72.7)).toBe(73);
    });

    it('handles NaN by returning default', () => {
      expect(clampBallSize(NaN)).toBe(BALL_SIZE_DEFAULT);
    });
  });
});
