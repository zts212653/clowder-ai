/**
 * F229 E3: ball size constants
 *
 * Validates that MIN/MAX size constants are exported and within sprite resolution bounds.
 */
import { describe, expect, it } from 'vitest';
import { BALL_SIZE_DEFAULT, BALL_SIZE_MAX, BALL_SIZE_MIN, clampBallSize } from '../src/types/concierge.js';

describe('ball size (E3)', () => {
  it('exports the approved compact desktop size', () => {
    expect(BALL_SIZE_MIN).toBe(43);
    expect(clampBallSize(42)).toBe(43);
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
