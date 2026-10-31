import { describe, expect, it } from 'vitest';
import { linearRgbLuminance, type OklchColor, oklchToClippedLinearRgb } from '../color-utils';
import { gradientBackground, nameContrast } from '../readable-name-role';

/**
 * Cloud review of #5086, round 4: the gradient behind the glyphs was checked at seven points, so a name could be accepted at
 * 4.507 where the continuous minimum is 4.486. The gradient is now taken exactly, as the interval of luminances it spans, and
 * these tests pin that interval against a brute force that shares none of its reasoning.
 */
const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** The luminance range over `steps` + 1 blends, straight from the definition. */
function sampledRange(top: OklchColor, under: OklchColor, steps: number) {
  const a = oklchToClippedLinearRgb(top);
  const b = oklchToClippedLinearRgb(under);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lum = linearRgbLuminance(
      a.map((v, k) => toLin(toSrgb(v) * t + toSrgb(b[k]) * (1 - t))) as [number, number, number],
    );
    low = Math.min(low, lum);
    high = Math.max(high, lum);
  }
  return { low, high };
}

const PAIRS: Array<[OklchColor, OklchColor]> = [
  [
    { l: 0.55, c: 0.45, h: 30 },
    { l: 0.79, c: 0.01, h: 243 },
  ], // a saturated plate into a near-neutral page
  [
    { l: 0.85, c: 0.1, h: 250 },
    { l: 0.1, c: 0.006, h: 80 },
  ], // a light plate into a near-black layer
  [
    { l: 0.3, c: 0.4, h: 142 },
    { l: 0.99, c: 0.006, h: 80 },
  ],
  [
    { l: 0.5, c: 0.3, h: 328 },
    { l: 0.5, c: 0.3, h: 142 },
  ], // two saturated surfaces of different hue at one lightness
  [
    { l: 0.6, c: 0, h: 0 },
    { l: 0.6, c: 0, h: 0 },
  ], // the same surface
];

describe('gradientBackground', () => {
  it('is the exact luminance interval of the blend: it matches a 4001-point brute force, and is never above its minimum', () => {
    for (const [top, under] of PAIRS) {
      const { gradient } = gradientBackground(top, under);
      const brute = sampledRange(top, under, 4000);

      expect(gradient.high).toBeCloseTo(brute.high, 9);
      expect(gradient.low).toBeLessThanOrEqual(brute.low + 1e-12); // exact: a sample can only sit at or above the true minimum
      expect(gradient.low).toBeGreaterThanOrEqual(brute.low - 1e-6); // and not far below it
    }
  });

  it('can dip under both ends: the luminance of an sRGB blend is not monotone for surfaces of different hue', () => {
    const [top, under] = PAIRS[3];
    const { gradient } = gradientBackground(top, under);
    const ends = sampledRange(top, under, 1);

    expect(gradient.low).toBeLessThan(ends.low - 1e-4);
  });

  it('a name inside the interval reads at 1:1 somewhere on the gradient; one outside is judged at the nearer end', () => {
    const [top, under] = PAIRS[1];
    const { gradient } = gradientBackground(top, under);
    const inside = { l: 0.6, c: 0, h: 0 };
    const lum = linearRgbLuminance(oklchToClippedLinearRgb(inside));

    expect(lum).toBeGreaterThan(gradient.low);
    expect(lum).toBeLessThan(gradient.high);
    expect(nameContrast(inside, { gradient })).toBe(1);
    expect(nameContrast({ l: 0, c: 0, h: 0 }, { gradient })).toBeGreaterThan(1);
  });
});
