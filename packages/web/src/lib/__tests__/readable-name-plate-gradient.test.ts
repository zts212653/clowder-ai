import { describe, expect, it } from 'vitest';
import { linearRgbLuminance, oklchToClippedLinearRgb } from '../color-utils';
import { type ActualPlateColour, platesOf, resolveNameAndPlate } from '../readable-name-plate';
import { NAME_ROLE_MIN_CONTRAST, nameContrast } from '../readable-name-role';
import { cartesian, lightPages } from './readable-name-plate-fixtures';

/** The plate is a gradient (cloud review of #5086, round 2): the name is checked over every blend behind the glyphs. */
describe('resolveNameAndPlate — the gradient', () => {
  describe('the plate is a gradient: the name is checked over every composite behind it (cloud review #5086, round 2)', () => {
    // CatNameplate paints linear-gradient(surface, transparent) over the work surface, so behind the glyphs there is every sRGB
    // blend between the two, not only the two ends. Independent oracle: the worst contrast over 19 blends of each plate and page (the model itself takes the gradient exactly).
    const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const gradientWorst = (
      nameL: number,
      name: { c: number; h: number },
      plateL: number,
      cmul: number,
      colours: ActualPlateColour[],
      pages: { l: number; c: number; h: number }[],
    ) => {
      const fg = linearRgbLuminance(oklchToClippedLinearRgb({ l: nameL, c: name.c, h: name.h }));
      let worst = Number.POSITIVE_INFINITY;
      for (const colour of colours) {
        const plate = oklchToClippedLinearRgb({ l: plateL, c: colour.c * cmul, h: colour.h });
        for (const page of pages) {
          const under = oklchToClippedLinearRgb(page);
          for (let i = 0; i <= 20; i++) {
            const a = i / 20;
            const blend = plate.map((v, k) => toLin(toSrgb(v) * a + toSrgb(under[k]) * (1 - a))) as [
              number,
              number,
              number,
            ];
            worst = Math.min(worst, ratio(fg, linearRgbLuminance(blend)));
          }
        }
      }
      return worst;
    };
    // A tuned Light theme (surface chroma 2.2) and one saturated blue-ish cat at a saturated step: both ends read a saved .4
    // name at 4.55:1, the middle of the gradient does not (4.27:1).
    const tunedPages = [
      { l: 0.78, c: 0.0132, h: 80 },
      { l: 0.8, c: 0.0108, h: 80 },
      { l: 0.9, c: 0.0045, h: 80 },
      { l: 0.9, c: 0.0027, h: 80 },
    ];
    const saturated = [{ h: 225, c: 0.3 }];
    const tuned = {
      saved: { l: 0.4, c: 0.025, h: 144 },
      plate: { l: 0.78, cmul: 2 },
      colours: saturated,
      pages: tunedPages.map((p) => ({ ...p, nameAlpha: 0.8 })),
      prefer: 'darker' as const,
    };

    it('is a real gradient case: the ends read the saved name, the middle of the gradient does not', () => {
      const ends = Math.min(
        ...platesOf(tuned.plate, saturated).map((bg) => nameContrast({ l: 0.4, c: 0.025, h: 144 }, bg)),
        ...tunedPages.map((bg) => nameContrast({ l: 0.4, c: 0.025, h: 144 }, bg)),
      );
      const inside = gradientWorst(0.4, tuned.saved, 0.78, 2, saturated, tunedPages);

      expect(ends).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
      expect(inside).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    });

    it('does not call a name that dips under 4.5 in the middle of the gradient "reads"', () => {
      // A saturated step (Cmul 2) with a saturated purple cat at plate .5: with only the two ends checked the plate walks to
      // .75, the name goes to .285 and the result is "reached" at 4.50 while the middle of the gradient is at 4.19.
      const colours = [{ h: 300, c: 0.3 }];
      const result = resolveNameAndPlate({ ...tuned, plate: { l: 0.5, cmul: 2 }, colours });
      const inside = gradientWorst(result.l, tuned.saved, result.plateL, 2, colours, tunedPages);

      expect(result.reachable).toBe(true);
      expect(inside).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST - 0.02);
    });

    it('whatever it calls reached reads over the whole gradient (within the sampling the model uses)', () => {
      for (const [plateL, cmul, h, nameL] of cartesian(
        [0.5, 0.78],
        [0.45, 0.99, 2],
        [30, 150, 225, 300],
        [0.15, 0.4, 0.55],
      )) {
        const colours = [{ h, c: 0.3 }];
        const result = resolveNameAndPlate({
          ...tuned,
          saved: { l: nameL, c: 0.025, h: 144 },
          plate: { l: plateL, cmul },
          colours,
        });
        if (!result.reachable) continue;
        const inside = gradientWorst(result.l, tuned.saved, result.plateL, cmul, colours, tunedPages);
        expect(inside, JSON.stringify({ plateL, cmul, h, nameL, result })).toBeGreaterThanOrEqual(
          NAME_ROLE_MIN_CONTRAST - 0.02,
        );
      }
    });

    it('stays fast when both passes run to the end on 29 saturated colours (the worst case: nothing reads)', () => {
      const many = Array.from({ length: 29 }, (_, i) => ({ h: (i * 37) % 360, c: 0.2 + ((i * 7) % 12) / 100 }));
      const started = performance.now();
      const result = resolveNameAndPlate({
        saved: { l: 0.4, c: 0.025, h: 144 },
        plate: { l: 0.1, cmul: 2 },
        colours: many,
        pages: lightPages,
        prefer: 'darker',
      });
      const took = performance.now() - started;

      expect(result.reachable).toBe(false); // both walks ran to the page
      // Guards the complexity class (an accidental quadratic or unmemoised walk is hundreds of times slower), not a latency promise: it takes
      // about 200 ms on a quiet machine and a loaded box runs several times slower, so the budget is far above that figure.
      expect(took).toBeLessThan(5000);
    });

    it('stays fast on a real catalogue (29 colours): one resolution in well under a second', () => {
      const many = Array.from({ length: 29 }, (_, i) => ({ h: (i * 37) % 360, c: 0.05 + ((i * 13) % 20) / 100 }));
      const started = performance.now();
      resolveNameAndPlate({ ...tuned, colours: many, plate: { l: 0.5, cmul: 0.99 } });
      // Guards the complexity class (an accidental quadratic or unmemoised walk is hundreds of times slower), not a latency promise: it takes
      // about 30 ms on a quiet machine and a loaded box runs several times slower, so the budget is far above that figure.
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });
});
