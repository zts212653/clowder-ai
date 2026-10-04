import { describe, expect, it } from 'vitest';
import { oklchContrast } from '../color-utils';
import {
  CLASSIC_NAME_OPACITY,
  NAME_ROLE_MIN_CONTRAST,
  NAME_ROLE_STEP,
  NAME_ROLE_TARGET_CONTRAST,
  nameContrast,
  platesFor,
  readableNameLightness,
} from '../readable-name-role';

/**
 * F322 B — the cat-name role has to stay readable in the theme the user actually saved (DESIGN.md「对话」: the name,
 * against what really sits behind it in the current theme, >= 4.5:1). Independent Alpha acceptance of #4978
 * (2026-10-01) saved a custom theme the Tuner allows: Light plate surface L .78 / Cmul .99 and a name role at L .78
 * (H 144, C .025) — names at 1.1:1 on the plate and 1.9:1 even on the plain page.
 *
 * The role is the user's choice and the saved value is never rewritten. These tests pin the function that turns the
 * saved lightness into the lightness that is drawn: untouched when it already reads, otherwise the nearest lightness
 * that does, with the user's hue and chroma left alone (they are not inputs the function can change).
 */
const HUE = 144;
const CHROMA = 0.025;

/** Light theme from the Alpha repro: plate surface step L .78 / Cmul .99, work surface L .99. */
const lightWork = { l: 0.99, c: 0.015, h: 80 };
const lightPlates = platesFor({ l: 0.78, cmul: 0.99 });

const worst = (l: number, backgrounds: readonly { l: number; c: number; h: number }[]) =>
  Math.min(...backgrounds.map((bg) => oklchContrast({ l, c: CHROMA, h: HUE }, bg)));

describe('readableNameLightness', () => {
  it('leaves a name that already reads exactly as it is', () => {
    const result = readableNameLightness({ l: 0.15, c: CHROMA, h: HUE, backgrounds: [...lightPlates, lightWork] });

    expect(result).toMatchObject({ l: 0.15, adjusted: false, reachable: true });
  });

  it('pulls the Alpha repro name (L .78 on a .78 plate, .99 page) to the nearest lightness that reads', () => {
    const backgrounds = [...lightPlates, lightWork];
    expect(worst(0.78, backgrounds)).toBeLessThan(1.5); // the saved value really is unreadable

    const result = readableNameLightness({ l: 0.78, c: CHROMA, h: HUE, backgrounds });

    expect(result.adjusted).toBe(true);
    expect(result.reachable).toBe(true);
    // Only the dark side can reach 4.5 against a .99 page and a .78 plate: the nearest passing lightness is darker.
    expect(result.l).toBeLessThan(0.78);
    expect(result.l).toBeGreaterThan(0.25);
    expect(worst(result.l, backgrounds)).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
  });

  it('moves no further than it has to: one step closer to the saved value falls short of the target', () => {
    const backgrounds = [...lightPlates, lightWork];
    const result = readableNameLightness({ l: 0.78, c: CHROMA, h: HUE, backgrounds });

    expect(worst(result.l, backgrounds)).toBeGreaterThanOrEqual(NAME_ROLE_TARGET_CONTRAST);
    expect(worst(result.l + NAME_ROLE_STEP, backgrounds)).toBeLessThan(NAME_ROLE_TARGET_CONTRAST);
  });

  it('moves toward the side that is reachable in a dark theme too (name too dark on a dark page)', () => {
    const darkPlates = platesFor({ l: 0.28, cmul: 0.25 });
    const darkWork = { l: 0.18, c: 0.003, h: 30 };
    const backgrounds = [...darkPlates, darkWork];

    const result = readableNameLightness({ l: 0.2, c: CHROMA, h: HUE, backgrounds });

    expect(result.adjusted).toBe(true);
    expect(result.l).toBeGreaterThan(0.2);
    expect(worst(result.l, backgrounds)).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
  });

  it('does not pick a side by a fixed rule: the same name is pulled the other way on a dark page', () => {
    const lightSide = readableNameLightness({
      l: 0.5,
      c: CHROMA,
      h: HUE,
      backgrounds: [...platesFor({ l: 0.85, cmul: 0.45 }), lightWork],
    });
    const darkSide = readableNameLightness({
      l: 0.5,
      c: CHROMA,
      h: HUE,
      backgrounds: [...platesFor({ l: 0.28, cmul: 0.25 }), { l: 0.18, c: 0.003, h: 30 }],
    });

    expect(lightSide.l).toBeLessThan(0.5);
    expect(darkSide.l).toBeGreaterThan(0.5);
  });

  it('says so when no lightness can read, and returns the best one instead of pretending', () => {
    // A page and a plate that sit at opposite lightness blocks every name colour at once.
    const blocked = [
      { l: 0.15, c: 0, h: 0 },
      { l: 0.95, c: 0, h: 0 },
    ];

    const result = readableNameLightness({ l: 0.5, c: CHROMA, h: HUE, backgrounds: blocked });

    expect(result.reachable).toBe(false);
    expect(result.adjusted).toBe(true);
    // The best a name can do is the point that is farthest from both at once, and it is reported honestly.
    expect(worst(result.l, blocked)).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    expect(worst(result.l, blocked)).toBeGreaterThanOrEqual(worst(0.5, blocked) - 1e-9);
  });

  it('never returns a lightness outside the colour range, and is the same every time', () => {
    const args = { l: 0.78, c: CHROMA, h: HUE, backgrounds: [...lightPlates, lightWork] };
    const a = readableNameLightness(args);
    const b = readableNameLightness(args);

    expect(a).toEqual(b);
    expect(a.l).toBeGreaterThanOrEqual(0);
    expect(a.l).toBeLessThanOrEqual(1);
  });

  it('treats a malformed saved lightness as unknown, not as a readable one', () => {
    const result = readableNameLightness({
      l: Number.NaN,
      c: CHROMA,
      h: HUE,
      backgrounds: [...lightPlates, lightWork],
    });

    expect(Number.isFinite(result.l)).toBe(true);
    expect(result.adjusted).toBe(true);
    expect(worst(result.l, [...lightPlates, lightWork])).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
  });
});

describe('which side a name moves to when both sides can read', () => {
  // With the criterion itself as the target (4.5) a window of backgrounds exists where a darker name and a lighter name
  // both read: L .56 is in it. (With the headroom in the real target no background leaves both sides open.)
  const mid = [{ l: 0.56, c: 0, h: 0 }];
  const target = NAME_ROLE_MIN_CONTRAST;

  it('follows the direction the theme draws its text in when the two sides are about equally far', () => {
    const toDark = readableNameLightness({ l: 0.52, c: 0, h: 0, backgrounds: mid, prefer: 'darker', target });
    const toLight = readableNameLightness({ l: 0.52, c: 0, h: 0, backgrounds: mid, prefer: 'lighter', target });

    expect(toDark.reachable && toLight.reachable).toBe(true);
    expect(toDark.l).toBeLessThan(0.52);
    expect(toLight.l).toBeGreaterThan(0.52);
  });

  it('does not flip between sides while a slider is dragged around the middle: neighbouring saved values keep one side', () => {
    const sides = [0.5, 0.51, 0.52, 0.53, 0.54].map((l) =>
      Math.sign(readableNameLightness({ l, c: 0, h: 0, backgrounds: mid, prefer: 'darker', target }).l - l),
    );

    expect(new Set(sides).size).toBe(1);
  });

  it('still takes the clearly nearer side when the sides are not about equally far', () => {
    // Saved well toward the dark end of what reads: the nearer side wins whatever direction the theme draws text in.
    const nearDark = readableNameLightness({ l: 0.3, c: 0, h: 0, backgrounds: mid, prefer: 'lighter', target });

    expect(nearDark.l).toBeLessThan(0.3);
  });

  it('with the real target (headroom included) no single background leaves both sides open, so the rule never has to fire', () => {
    const open = (l: number) => {
      const bg = [{ l, c: 0, h: 0 }];
      const dark = readableNameLightness({ l: 0.5, c: 0, h: 0, backgrounds: bg, prefer: 'darker' });
      const light = readableNameLightness({ l: 0.5, c: 0, h: 0, backgrounds: bg, prefer: 'lighter' });
      return dark.reachable && light.reachable && dark.l < 0.5 !== light.l < 0.5;
    };
    const both = Array.from({ length: 200 }, (_, i) => i / 200).filter(open);

    expect(both).toEqual([]);
  });
});

describe('a name drawn at less than full opacity', () => {
  // The classic header draws the cat name at 80% opacity over the page.
  const page = { l: 0.18, c: 0.003, h: 30 };

  it('measures the name as it is drawn: its colour blended with what is behind it', () => {
    const solid = nameContrast({ l: 0.5, c: CHROMA, h: HUE }, page);
    const faded = nameContrast({ l: 0.5, c: CHROMA, h: HUE }, { ...page, nameAlpha: CLASSIC_NAME_OPACITY });

    expect(faded).toBeLessThan(solid);
    expect(faded).toBeGreaterThan(1);
  });

  it('asks a faded name to be further from the page than a solid one', () => {
    const solid = readableNameLightness({ l: 0.2, c: CHROMA, h: HUE, backgrounds: [page], prefer: 'lighter' });
    const faded = readableNameLightness({
      l: 0.2,
      c: CHROMA,
      h: HUE,
      backgrounds: [{ ...page, nameAlpha: CLASSIC_NAME_OPACITY }],
      prefer: 'lighter',
    });

    expect(faded.l).toBeGreaterThan(solid.l);
    expect(
      nameContrast({ l: faded.l, c: CHROMA, h: HUE }, { ...page, nameAlpha: CLASSIC_NAME_OPACITY }),
    ).toBeGreaterThanOrEqual(NAME_ROLE_TARGET_CONTRAST);
  });
});

describe('platesFor', () => {
  it('covers every hue a cat can have, at the chroma the step multiplies', () => {
    const plates = platesFor({ l: 0.78, cmul: 0.99 });

    expect(new Set(plates.map((p) => p.h)).size).toBeGreaterThanOrEqual(12);
    expect(plates.every((p) => p.l === 0.78)).toBe(true);
    expect(plates.some((p) => p.c === 0)).toBe(true);
    expect(Math.max(...plates.map((p) => p.c))).toBeGreaterThan(0.15 * 0.99);
  });
});

describe("a criterion other than the name role's (the 3:1 of a non-text mark)", () => {
  const page = { l: 0.99, c: 0.015, h: 80 };
  const colour = { c: 0.04, h: 58 };
  const readsAt = (l: number) => nameContrast({ l, ...colour }, page);

  it('keeps a value that meets the given minimum even when it is under the headroom the search aims for', () => {
    // Find a lightness whose contrast on the page is between the minimum (3) and the target (3.15).
    let between: number | undefined;
    for (let l = 0.7; l > 0.3 && between === undefined; l -= 0.001) {
      const ratio = readsAt(l);
      if (ratio >= 3 && ratio < 3.15) between = Math.round(l * 1000) / 1000;
    }
    expect(between).toBeDefined();

    const result = readableNameLightness({
      l: between as number,
      ...colour,
      backgrounds: [page],
      minimum: 3,
      target: 3.15,
    });

    expect(result).toMatchObject({ l: between, adjusted: false, reachable: true });
  });

  it('moves a value under the minimum to the nearest lightness that reaches the target, not further', () => {
    const result = readableNameLightness({ l: 0.9, ...colour, backgrounds: [page], minimum: 3, target: 3.15 });

    expect(result.adjusted).toBe(true);
    expect(readsAt(result.l)).toBeGreaterThanOrEqual(3.15);
    expect(readsAt(result.l + NAME_ROLE_STEP)).toBeLessThan(3.15);
  });
});

describe('a contrast the caller computes itself (a mark whose colour and whose neighbours are a whole range)', () => {
  // A stand-in contrast that is 1 at lightness 0.2 and rises by 8 per unit of lightness away from it.
  const contrastAt = (l: number) => 1 + 8 * Math.abs(l - 0.2);

  it('keeps a saved value that already meets the minimum', () => {
    const result = readableNameLightness({ l: 0.8, c: 0, h: 0, backgrounds: [], contrastAt, minimum: 3, target: 3.15 });

    expect(result).toMatchObject({ l: 0.8, adjusted: false, reachable: true });
  });

  it('moves a value under the minimum to the nearest lightness that reaches the target, and no further', () => {
    const result = readableNameLightness({ l: 0.3, c: 0, h: 0, backgrounds: [], contrastAt, minimum: 3, target: 3.15 });

    expect(result.adjusted).toBe(true);
    expect(result.reachable).toBe(true);
    expect(contrastAt(result.l)).toBeGreaterThanOrEqual(3.15);
    // Nearest passing lightness on the dark side is 0.2 - 0.269 < 0, so the light side (0.469) is the only one open.
    expect(result.l).toBeGreaterThan(0.3);
    expect(contrastAt(result.l - NAME_ROLE_STEP)).toBeLessThan(3.15);
  });

  it('says so when nothing reads and returns the best one', () => {
    const flat = (l: number) => 1 + 0.5 * l;
    const result = readableNameLightness({
      l: 0.4,
      c: 0,
      h: 0,
      backgrounds: [],
      contrastAt: flat,
      minimum: 3,
      target: 3.15,
    });

    expect(result.reachable).toBe(false);
    expect(result.l).toBe(1);
  });

  it('is used instead of the pairwise search when given, and the pairwise one is unchanged without it', () => {
    const page = { l: 0.99, c: 0.015, h: 80 };
    const pairwise = readableNameLightness({ l: 0.8, c: 0.04, h: 58, backgrounds: [page], minimum: 3, target: 3.15 });
    const same = readableNameLightness({
      l: 0.8,
      c: 0.04,
      h: 58,
      backgrounds: [page],
      contrastAt: (l) => nameContrast({ l, c: 0.04, h: 58 }, page),
      minimum: 3,
      target: 3.15,
    });

    expect(same).toEqual(pairwise);
  });

  it("stays quick with a sixty-background sweep of a single colour (the name role's own use)", () => {
    const backgrounds = [...platesFor({ l: 0.85, cmul: 0.45 }), { l: 0.99, c: 0.015, h: 80 }];
    const started = performance.now();

    readableNameLightness({ l: 0.62, c: 0.1, h: 58, backgrounds, minimum: 3, target: 3.15 });

    expect(performance.now() - started).toBeLessThan(1500);
  });
});
