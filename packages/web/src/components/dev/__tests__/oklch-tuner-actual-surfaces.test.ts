import { describe, expect, it } from 'vitest';
import { linearRgbLuminance, oklchToClippedLinearRgb } from '@/lib/color-utils';
import { readHueChroma } from '@/lib/theme-colour-sources';
import { buildCSS } from '../oklch-tuner-css';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '../oklch-tuner-engine';
import { type ActualColours, drawnNameLightness, pageLayers, resolveTunerNameAndPlate } from '../oklch-tuner-name-role';

/**
 * F322 B follow-up (Opus 5.5 3327 + 3619): the name role and the plate are resolved against the cats, connectors and human
 * colour that really exist, and a plate that has to give way is shifted at display time only — what the user saved is never
 * rewritten. When the catalogue or a colour changes, the same call gives a new answer.
 */
const NO_HC = { on: false, hue: 0, chroma: 0 };
const HUMAN = { h: 58, c: 0.04 };
const REGULAR: ActualColours = {
  cats: [
    { h: 250, c: 0.12 },
    { h: 25, c: 0.15 },
    { h: 145, c: 0.1 },
    { h: 300, c: 0.14 },
    { h: 60, c: 0.13 },
  ],
  human: HUMAN,
};
const withCat = (actual: ActualColours, cat: { h: number; c: number }): ActualColours => ({
  ...actual,
  cats: [...actual.cats, cat],
});
const MAGENTA = { h: 328, c: 0.3 };

const cssVar = (css: string, scope: ':root' | '[data-theme="dark"]', name: string) => {
  const block = css.split('}').find((rule) => rule.trimStart().startsWith(`${scope}{--cat-bubble-l`));
  const match = block?.match(new RegExp(`--${name}:([^;}]+)`));
  if (!match) throw new Error(`no ${scope} --${name} in the generated CSS`);
  return match[1];
};

function lightWithPlate(l: number, cmul = 0.99): TunerState {
  const p = structuredClone(INIT_LIGHT);
  p.light.surface = { L: l, Cmul: cmul };
  return p;
}

describe('resolveTunerNameAndPlate with the colours that exist', () => {
  it('leaves every built-in theme exactly as saved, in both modes, for an ordinary catalogue', () => {
    for (const base of [INIT_LIGHT, INIT_DARK]) {
      expect(resolveTunerNameAndPlate(base, false, REGULAR)).toMatchObject({
        l: base.catTextLightL,
        plateL: base.light.surface.L,
        adjusted: false,
        plateShifted: false,
        reachable: true,
      });
      expect(resolveTunerNameAndPlate(base, true, REGULAR)).toMatchObject({
        l: base.catTextDarkL,
        plateL: base.dark.surface.L,
        adjusted: false,
        plateShifted: false,
        reachable: true,
      });
    }
  });

  it('lets the plate give way, not the name, when a dark plate sits under a dark name on a light page', () => {
    const p = lightWithPlate(0.4);
    const result = resolveTunerNameAndPlate(p, false, REGULAR);

    expect(result.l).toBe(p.catTextLightL); // the name does not move
    expect(result.plateShifted).toBe(true);
    expect(result.plateL).toBeGreaterThan(0.4); // toward the light page
    expect(result.reachable).toBe(true);
  });

  it('puts the shifted plate in the generated CSS, and never rewrites what the user saved', () => {
    const p = lightWithPlate(0.4);
    const before = structuredClone(p);
    const result = resolveTunerNameAndPlate(p, false, REGULAR);
    const css = buildCSS(p, NO_HC, REGULAR);

    expect(Number(cssVar(css, ':root', 'cat-surface-l'))).toBe(result.plateL);
    expect(Number(cssVar(css, ':root', 'cat-name-l'))).toBe(p.catTextLightL);
    expect(cssVar(css, ':root', 'cat-surface-cmul')).toBe('0.99'); // chroma multiplier untouched
    expect(p).toEqual(before);
  });

  it('is decided per mode: a Light plate that gives way does not move Dark', () => {
    const p = lightWithPlate(0.4);
    const css = buildCSS(p, NO_HC, REGULAR);

    expect(Number(cssVar(css, '[data-theme="dark"]', 'cat-surface-l'))).toBe(p.dark.surface.L);
  });

  it('recomputes when the catalogue changes: an extreme cat moves a name that read, and removing it brings it back', () => {
    const p = lightWithPlate(0.6);
    const before = resolveTunerNameAndPlate(p, false, REGULAR);
    const withExtreme = resolveTunerNameAndPlate(p, false, withCat(REGULAR, MAGENTA));
    const removed = resolveTunerNameAndPlate(p, false, REGULAR);

    expect(before.l).toBe(p.catTextLightL); // reads as saved with the cats that exist
    expect(withExtreme.l).toBeLessThan(before.l); // an extreme cat makes it move
    expect(withExtreme.adjusted).toBe(true);
    expect(removed).toEqual(before); // and it is a pure function of what is in the room
    expect(drawnNameLightness(p, false, withCat(REGULAR, MAGENTA))).toBe(withExtreme.l);
  });

  it('recomputes when the human colour changes', () => {
    const p = lightWithPlate(0.6);
    const quiet = resolveTunerNameAndPlate(p, false, { ...REGULAR, human: { h: 58, c: 0.04 } });
    const loud = resolveTunerNameAndPlate(p, false, { ...REGULAR, human: MAGENTA });

    expect(loud.l === quiet.l && loud.plateL === quiet.plateL).toBe(false);
  });

  it('does not decide anything from a colour that is not there: an ordinary catalogue stays near the saved values', () => {
    const p = lightWithPlate(0.78, 0.99);
    const result = resolveTunerNameAndPlate(p, false, REGULAR);

    expect(result).toMatchObject({ l: p.catTextLightL, adjusted: false, plateShifted: false });
  });

  it('keeps the old sweep as the fallback only when nothing is known about the room (no catalogue yet)', () => {
    const p = lightWithPlate(0.78);
    const swept = resolveTunerNameAndPlate(p, false);
    const css = buildCSS(p, NO_HC);

    expect(Number(cssVar(css, ':root', 'cat-name-l'))).toBe(swept.l);
    expect(Number(cssVar(css, ':root', 'cat-surface-l'))).toBe(swept.plateL);
  });
});

describe('the moving-name pass accepts a result that meets the criterion without headroom (cloud #5086 round 3)', () => {
  // A Dark theme with a saturated blue cat, every page layer at .635, plate step .6 / Cmul .99, saved name .87 / C .1 / H 136:
  // no plate lightness reads for the work-surface name, and the first name lightness that reads is a barely-passing one (4.51:1)
  // at plate .63. It used to be reported as not reached at 4.41:1 because only a 4.65 result was accepted in that pass.
  const blue: ActualColours = { cats: [{ h: 264.05, c: 0.313 }], human: HUMAN };
  const dark = () => {
    const p = structuredClone(INIT_DARK);
    p.dark.elev = { sunken: 0.635, base: 0.635, elevated: 0.635, canvas: 0.635 };
    p.dark.surface = { L: 0.6, Cmul: 0.99 };
    p.catTextDarkL = 0.87;
    p.catTextC = 0.1;
    p.catTextH = 136;
    return p;
  };

  it('is reached, at the criterion, with the name and the plate both moved', () => {
    const result = resolveTunerNameAndPlate(dark(), true, blue);

    expect(result).toMatchObject({ reachable: true, adjusted: true, plateShifted: true });
    expect(result.worst).toBeGreaterThanOrEqual(4.5);
    expect(result.worst).toBeLessThan(4.65);
  });
});

describe('the gradient behind the glyphs is checked continuously, not at a few points (cloud #5086 round 4)', () => {
  // The cloud's legal Tuner values: Light, surface hue 243 / chroma 1.4, page elevations 1 / 1 / .79 / 1, plate step .55 / Cmul 1.6,
  // saved name .12 / C .295 / H 167, and one #ff5600 source that is also the human colour. Seven points along the gradient read
  // 4.507; the continuous minimum is 4.486. A saved name must not be accepted unchanged on the sampled number.
  const cat = readHueChroma('#ff5600') as { h: number; c: number };
  const room: ActualColours = { cats: [cat], human: cat };
  const light = () => {
    const p = structuredClone(INIT_LIGHT);
    p.surfaceHue = 243;
    p.surfaceChroma = 1.4;
    p.light.elev = { sunken: 1, base: 1, elevated: 0.79, canvas: 1 };
    p.light.surface = { L: 0.55, Cmul: 1.6 };
    p.catTextLightL = 0.12;
    p.catTextC = 0.295;
    p.catTextH = 167;
    return p;
  };
  const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  /** Independent oracle: the lowest contrast over 2001 blends of the plate into each page layer. */
  const continuousMin = (p: TunerState, nameL: number, plateL: number) => {
    const fg = linearRgbLuminance(oklchToClippedLinearRgb({ l: nameL, c: p.catTextC, h: p.catTextH }));
    const plate = oklchToClippedLinearRgb({ l: plateL, c: cat.c * p.light.surface.Cmul, h: cat.h });
    let lowest = Number.POSITIVE_INFINITY;
    for (const page of pageLayers(p, false)) {
      const under = oklchToClippedLinearRgb(page);
      for (let i = 0; i <= 2000; i++) {
        const a = i / 2000;
        const blend = plate.map((v, k) => toLin(toSrgb(v) * a + toSrgb(under[k]) * (1 - a))) as [
          number,
          number,
          number,
        ];
        lowest = Math.min(lowest, ratio(fg, linearRgbLuminance(blend)));
      }
    }
    return lowest;
  };

  it('is a real gap: the saved name dips under 4.5 in the middle of the gradient', () => {
    expect(continuousMin(light(), 0.12, 0.55)).toBeLessThan(4.5);
  });

  it('does not accept the saved name on the sampled number: something moves, and what is drawn reads continuously', () => {
    const p = light();
    const result = resolveTunerNameAndPlate(p, false, room);

    expect(result.adjusted || result.plateShifted).toBe(true);
    expect(result.reachable).toBe(true);
    expect(continuousMin(p, result.l, result.plateL)).toBeGreaterThanOrEqual(4.5 - 0.002);
  });
});
