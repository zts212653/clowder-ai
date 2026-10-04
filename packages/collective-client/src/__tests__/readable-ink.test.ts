import { describe, expect, it } from 'vitest';

import { DARK_INK, inkContrast, LIGHT_INK, readableInkOn } from '../readable-ink.js';

/**
 * F322 B — the ink of an initial written on the human-colour disc follows the disc, not the page. The room gets the disc's
 * colour from the host as an opaque `#rrggbb`; the ink is pure white or pure black, whichever reads better, and the pair is
 * never below the 4.5:1 text needs, whatever primary the host sends (light, dark, tuned).
 */
describe('the ink on the human-colour disc', () => {
  it('is white on a dark fill and black on a light one', () => {
    expect(readableInkOn('#6b5443')).toBe(LIGHT_INK);
    expect(readableInkOn('#1c1815')).toBe(LIGHT_INK);
    expect(readableInkOn('#e9dccf')).toBe(DARK_INK);
    expect(readableInkOn('#ffffff')).toBe(DARK_INK);
    expect(readableInkOn('#000000')).toBe(LIGHT_INK);
  });

  it('is the one the Café-side reader picks for the same fill: the reported counterexample, a warm mid-tone primary', () => {
    // 3.32:1 with the surface used as the ink; either pure ink does better on this fill.
    const fill = '#c66846';
    const ink = readableInkOn(fill);
    expect(ink).toBeDefined();
    expect(inkContrast(ink as string, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads at 4.5:1 or better on every fill the bridge can carry (a 17³ sweep of the sRGB cube, plus the grey axis)', () => {
    const steps = Array.from({ length: 17 }, (_, i) => Math.min(255, i * 16));
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    let worst = Number.POSITIVE_INFINITY;
    const fills = [
      ...steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${hex(r)}${hex(g)}${hex(b)}`))),
      ...Array.from({ length: 256 }, (_, v) => `#${hex(v)}${hex(v)}${hex(v)}`),
    ];
    for (const fill of fills) {
      const ink = readableInkOn(fill);
      expect(ink, fill).toBeDefined();
      worst = Math.min(worst, inkContrast(ink as string, fill));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('makes no claim for what is not an opaque #rrggbb', () => {
    for (const fill of [
      '',
      'cocoa',
      '#fff',
      '#ffffff80',
      'rgb(1,2,3)',
      'oklch(0.62 0.04 58)',
      'var(--human-primary)',
    ]) {
      expect(readableInkOn(fill), fill).toBeUndefined();
    }
    expect(Number.isNaN(inkContrast('#000000', 'cocoa'))).toBe(true);
  });
});
