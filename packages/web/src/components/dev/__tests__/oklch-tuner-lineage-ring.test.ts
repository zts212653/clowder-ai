import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hexToOklch, linearRgbLuminance, oklchToClippedLinearRgb } from '@/lib/color-utils';
import { nameContrast } from '@/lib/readable-name-role';
import { buildCSS } from '../oklch-tuner-css';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '../oklch-tuner-engine';
import {
  LINEAGE_RING_MAX_CHROMA,
  LINEAGE_RING_MIN_CONTRAST,
  LINEAGE_RING_TARGET_CONTRAST,
  lineageRingLightness,
  lineageRingWorstContrast,
  luminanceRange,
} from '../oklch-tuner-lineage-ring';
import { pageLayers } from '../oklch-tuner-name-role';

/**
 * F322 B - the lineage ring (`[data-lineage-focus]`): the ~3 second ring that lands on the message a receipt or an
 * absorption dock points back to. It is not text, so its criterion is the 3:1 of a non-text mark; it keeps the human's hue
 * and chroma and only has its lightness floored at display time (DESIGN.md「对话」, design owner 2026-10-01).
 *
 * The colours are the user's: the human colour is any hex the config takes (the injector writes its hue and chroma) and a
 * cat's plate is any cat colour. One lightness is drawn per theme, so the search has to cover the whole legal range, not a
 * sample of it. Sol6.1's review of the first version found a configured #00ff00 ring (H 142.5, C .295) on a configured
 * #ff00ff cat plate (H 328.4, C .322) at 2.88:1.
 */
const NO_HC = { on: false, hue: 0, chroma: 0 };
const variants = (): Array<[string, TunerState, boolean]> => {
  const out: Array<[string, TunerState, boolean]> = [];
  for (const [name, base, dark] of [
    ['light', INIT_LIGHT, false],
    ['dark', INIT_DARK, true],
  ] as const) {
    out.push([`${name} default`, base, dark]);
    const tuned = structuredClone(base);
    tuned.surfaceChroma = 2.2;
    (dark ? tuned.dark : tuned.light).surface = { L: dark ? 0.36 : 0.78, Cmul: dark ? 0.5 : 0.9 };
    out.push([`${name} tuned`, tuned, dark]);
  }
  return out;
};

/** A seeded generator, so the sweep is the same every run. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('the legal colour range the ring has to cover', () => {
  it('has a chroma ceiling no sRGB hex colour exceeds', () => {
    let highest = 0;
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          highest = Math.max(highest, hexToOklch(hex).c);
        }
      }
    }
    for (const hex of ['#00ff00', '#ff00ff', '#0000ff', '#ff0000', '#00ffff', '#ffff00', '#ffffff', '#000000']) {
      highest = Math.max(highest, hexToOklch(hex).c);
    }

    expect(highest).toBeGreaterThan(0.3);
    expect(highest).toBeLessThanOrEqual(LINEAGE_RING_MAX_CHROMA);
  });

  it('is sampled finely enough: a 1 degree / 0.01 chroma grid finds no luminance the search could be missing', () => {
    // The Tuner lets the chroma multiplier go from 0 to 2, so the range is checked well past 1.
    let worstShortfall = 0;
    for (const l of [0.05, 0.2, 0.35, 0.5, 0.62, 0.75, 0.85, 0.95]) {
      for (const cmul of [0.15, 0.45, 0.85, 1, 1.5, 2]) {
        const used = luminanceRange(l, cmul);
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let h = 0; h < 360; h += 1) {
          for (let c = 0; c <= LINEAGE_RING_MAX_CHROMA + 1e-9; c += 0.01) {
            const y = linearRgbLuminance(oklchToClippedLinearRgb({ l, c: c * cmul, h }));
            min = Math.min(min, y);
            max = Math.max(max, y);
          }
        }
        // What matters is the contrast: a luminance error of dY moves a contrast of R by about R * dY / (Y + 0.05).
        const lowSide = (used.min + 0.05) / (min + 0.05);
        const highSide = (max + 0.05) / (used.max + 0.05);
        worstShortfall = Math.max(worstShortfall, lowSide, highSide);
      }
    }
    // Under 3% in relative luminance is under 0.1 of contrast at 3:1, inside the 0.15 headroom the search keeps.
    expect(worstShortfall).toBeLessThan(1.03);
  });
});

describe('the lineage ring lightness', () => {
  it('reads for the configured pair that failed review: a #00ff00 ring on a #ff00ff cat plate, in every theme', () => {
    const human = hexToOklch('#00ff00');
    const cat = hexToOklch('#ff00ff');
    for (const [name, p, dark] of variants()) {
      const mode = dark ? p.dark : p.light;
      const l = lineageRingLightness(p, dark).l;

      const ratio = nameContrast(
        { l, c: human.c * mode.primary.Cmul, h: human.h },
        { l: mode.surface.L, c: cat.c * mode.surface.Cmul, h: cat.h },
      );

      expect(ratio, name).toBeGreaterThanOrEqual(LINEAGE_RING_MIN_CONTRAST);
    }
  });

  it('reads for every pair of extreme configured colours, over the plate and over every page layer', () => {
    const hexes = [
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#ffff00',
      '#00ffff',
      '#ff00ff',
      '#ffffff',
      '#000000',
      '#815b5b',
      '#6B5443',
    ];
    for (const [name, p, dark] of variants()) {
      const mode = dark ? p.dark : p.light;
      const l = lineageRingLightness(p, dark).l;
      for (const humanHex of hexes) {
        const human = hexToOklch(humanHex);
        const ring = { l, c: human.c * mode.primary.Cmul, h: human.h };
        for (const catHex of hexes) {
          const cat = hexToOklch(catHex);
          const plate = { l: mode.surface.L, c: cat.c * mode.surface.Cmul, h: cat.h };
          expect(nameContrast(ring, plate), `${name} ${humanHex} on ${catHex}`).toBeGreaterThanOrEqual(
            LINEAGE_RING_MIN_CONTRAST,
          );
        }
        for (const layer of pageLayers(p, dark)) {
          expect(nameContrast(ring, layer), `${name} ${humanHex} on a page layer`).toBeGreaterThanOrEqual(
            LINEAGE_RING_MIN_CONTRAST,
          );
        }
      }
    }
  });

  it('reads for random colours over the whole legal range, not just a grid', () => {
    const random = rng(4989);
    for (const [name, p, dark] of variants()) {
      const mode = dark ? p.dark : p.light;
      const l = lineageRingLightness(p, dark).l;
      const layers = pageLayers(p, dark);
      let lowest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 4000; i += 1) {
        const ring = { l, c: random() * LINEAGE_RING_MAX_CHROMA * mode.primary.Cmul, h: random() * 360 };
        const plate = {
          l: mode.surface.L,
          c: random() * LINEAGE_RING_MAX_CHROMA * mode.surface.Cmul,
          h: random() * 360,
        };
        lowest = Math.min(lowest, nameContrast(ring, plate), ...layers.map((layer) => nameContrast(ring, layer)));
      }
      expect(lowest, name).toBeGreaterThanOrEqual(LINEAGE_RING_MIN_CONTRAST);
    }
  });

  it('moves the built-in Light ring off the bubble lightness, because 0.62 does not reach 3:1 on a bubble', () => {
    const saved = INIT_LIGHT.light.primary.L;
    expect(lineageRingWorstContrast(INIT_LIGHT, false, saved)).toBeLessThan(LINEAGE_RING_MIN_CONTRAST);

    const result = lineageRingLightness(INIT_LIGHT, false);

    expect(result.adjusted).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.l).toBeLessThan(saved);
    expect(lineageRingWorstContrast(INIT_LIGHT, false, result.l)).toBeGreaterThanOrEqual(LINEAGE_RING_TARGET_CONTRAST);
  });

  it('moves no further than it has to', () => {
    for (const [name, p, dark] of variants()) {
      const result = lineageRingLightness(p, dark);
      if (!result.adjusted || !result.reachable) continue;
      const step = dark ? -0.005 : 0.005; // toward the saved value
      expect(lineageRingWorstContrast(p, dark, result.l + step), name).toBeLessThan(LINEAGE_RING_TARGET_CONTRAST);
    }
  });

  it('is deterministic and a number in range for every theme, and reports reachability', () => {
    for (const [name, p, dark] of variants()) {
      const first = lineageRingLightness(p, dark);
      expect(lineageRingLightness(p, dark), name).toEqual(first);
      expect(first.l).toBeGreaterThanOrEqual(0);
      expect(first.l).toBeLessThanOrEqual(1);
      expect(typeof first.reachable).toBe('boolean');
    }
  });

  it('never rewrites the saved theme', () => {
    const p = structuredClone(INIT_LIGHT);
    const before = structuredClone(p);

    lineageRingLightness(p, false);
    lineageRingLightness(p, true);
    buildCSS(p, NO_HC);

    expect(p).toEqual(before);
  });

  it('says when a theme leaves no lightness that reads, and returns the best one instead of pretending', () => {
    const blocked = structuredClone(INIT_DARK);
    // Page layers from near-black to near-white and a plate in the middle: a ring dark enough for the white one is too dark
    // for the black one, and the middle plate rules out the lightnesses in between.
    blocked.dark.surface = { L: 0.5, Cmul: 0.99 };
    blocked.dark.elev = { sunken: 0.15, base: 0.5, elevated: 0.9, canvas: 0.5 };

    const result = lineageRingLightness(blocked, true);

    expect(Number.isFinite(result.l)).toBe(true);
    expect(result.l).toBeGreaterThanOrEqual(0);
    expect(result.l).toBeLessThanOrEqual(1);
    expect(result.reachable).toBe(false);
  });

  it('stays quick: all four themes, both modes, well inside a Tuner slider drag', () => {
    const started = performance.now();
    for (const [, p, dark] of variants()) lineageRingLightness(p, dark);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('what buildCSS emits for it', () => {
  const emitted = (css: string, scope: ':root' | '[data-theme="dark"]') => {
    const block = css.split('}').find((rule) => rule.trimStart().startsWith(`${scope}{--cat-bubble-l`));
    const match = block?.match(/--cat-lineage-l:([^;}]+)/);
    if (!match) throw new Error(`no ${scope} --cat-lineage-l`);
    return Number(match[1]);
  };

  it('puts the drawn lightness next to the other cat tokens, per mode, and leaves the bubble lightness as saved', () => {
    const css = buildCSS(INIT_LIGHT, NO_HC);

    expect(emitted(css, ':root')).toBe(lineageRingLightness(INIT_LIGHT, false).l);
    expect(emitted(css, '[data-theme="dark"]')).toBe(lineageRingLightness(INIT_LIGHT, true).l);
    expect(css).toContain(`--cat-bubble-l:${INIT_LIGHT.light.primary.L};`);
    expect(css).toContain(`--cat-bubble-l:${INIT_LIGHT.dark.primary.L};`);
  });

  it('recomputes when the theme changes: a Tuner-adjusted Light gets its own value', () => {
    const tuned = variants().find(([name]) => name === 'light tuned')?.[1] as TunerState;

    expect(emitted(buildCSS(tuned, NO_HC), ':root')).not.toBe(emitted(buildCSS(INIT_LIGHT, NO_HC), ':root'));
  });
});

describe('the rule that uses it', () => {
  const globals = readFileSync(join(import.meta.dirname, '../../../app/globals.css'), 'utf8');
  const start = globals.indexOf('[data-lineage-focus="true"]');
  const rule = globals.slice(start, globals.indexOf('}', start));

  it('draws the ring in the human hue and chroma at the drawn lightness, not in the raw bubble role', () => {
    expect(rule).toContain('--cat-lineage-l');
    expect(rule).toContain('--cocreator-hue');
    expect(rule).toContain('--cocreator-chroma');
    expect(rule).not.toContain('--color-cocreator-primary');
  });
});
