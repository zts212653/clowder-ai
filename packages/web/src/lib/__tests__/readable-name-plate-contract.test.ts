import { describe, expect, it, vi } from 'vitest';
import { type ActualPlateColour, platesOf, resolveNameAndPlate, surfacesUnderName } from '../readable-name-plate';
import {
  NAME_ROLE_MIN_CONTRAST,
  NAME_ROLE_STEP,
  NAME_ROLE_TARGET_CONTRAST,
  nameContrast,
  worstContrastFor,
} from '../readable-name-role';
import {
  cartesian,
  darkPages,
  extremeColours,
  lightPages,
  midPages,
  platesToward,
  regularColours,
  spreadColours,
} from './readable-name-plate-fixtures';

// The completeness sweeps below brute-force a few hundred resolutions each. They are checks of correctness, not of speed, and they
// need about 7 s of CPU on a quiet machine, 11 s at a machine load of 30 and over 20 s at 60 (measured), against vitest's 10 s default:
// at the default a busy CI box failed them with no code change. A generous ceiling keeps them from timing out; a hang still fails.
vi.setConfig({ testTimeout: 120_000 });

/**
 * The resolver's reporting contract (codex-sol and cloud review of #5086): a result PASSES when its worst contrast meets the
 * criterion, `reachable` means exactly that, a headroom is only what a search prefers, and every field the page really moved is
 * reported — also when nothing reads.
 */
/**
 * The best worst-contrast any (name lightness, plate lightness) pair reaches, between the saved plate and the work surface.
 * The grids (names and plates, step .01, plates counted from the saved one) are subsets of the resolver's own (.005), so the
 * resolver can never legitimately do worse than this.
 */
function bruteBest(
  plate: { l: number; cmul: number },
  colours: ActualPlateColour[],
  pages: typeof lightPages,
  chroma: number,
  hue = 144,
): number {
  const pageMean = pages.reduce((sum, page) => sum + page.l, 0) / pages.length;
  const plates = platesToward(plate.l, pageMean);
  let best = 0;
  for (const p of plates) {
    const worstAt = worstContrastFor(surfacesUnderName({ l: p, cmul: plate.cmul }, colours, pages), chroma, hue);
    for (let n = 0; n <= 1.0001; n += 0.01) best = Math.max(best, worstAt(n));
  }
  return best;
}

describe('resolveNameAndPlate — the state and the number', () => {
  describe('the state and the number never contradict (codex-sol #5086 P1)', () => {
    // The name reads the work surface at 4.52:1 and that is as good as the plate can make it: the plate walks to the page side
    // and the best it reaches is above the criterion but short of the 4.65 headroom the search aims for.
    const plateau = {
      saved: { l: 0.4, c: 0.025, h: 0 },
      plate: { l: 0.2, cmul: 0.25 },
      colours: regularColours,
      pages: lightPages,
      prefer: 'darker' as const,
    };

    it('is reached when the best the plate can do is in [4.5, 4.65)', () => {
      const result = resolveNameAndPlate(plateau);

      expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
      expect(result.worst).toBeLessThan(NAME_ROLE_TARGET_CONTRAST);
      expect(result).toMatchObject({ reachable: true, plateShifted: true, adjusted: false, l: 0.4 });
    });

    it('moves the plate no further than it has to when the headroom cannot be had: one step back falls under the criterion', () => {
      // chatgpt-codex-connector #5086 P1: a preserved name that reads the page at 4.64:1 cannot give the plate 4.65 of headroom,
      // so every shift is short of the target. The plate must not run all the way to the page for that: it stops at the first
      // lightness at which the name reads on every plate.
      const neutral = {
        saved: { l: 0.375, c: 0, h: 0 },
        plate: { l: 0.5, cmul: 1 },
        colours: [{ h: 0, c: 0 }],
        pages: [{ l: 0.9, c: 0, h: 0, nameAlpha: 0.8 }],
        prefer: 'darker' as const,
      };
      const result = resolveNameAndPlate(neutral);
      const oneBack = Math.round((result.plateL - NAME_ROLE_STEP) * 10000) / 10000;
      const worstAtPlate = (plateL: number) =>
        Math.min(
          ...platesOf({ l: plateL, cmul: 1 }, neutral.colours).map((bg) => nameContrast({ ...neutral.saved }, bg)),
          ...neutral.pages.map((bg) => nameContrast({ ...neutral.saved }, bg)),
        );

      expect(result).toMatchObject({ reachable: true, plateShifted: true, adjusted: false, l: 0.375 });
      expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
      expect(result.worst).toBeLessThan(NAME_ROLE_TARGET_CONTRAST);
      expect(result.plateL).toBeLessThan(0.8); // it did not run to the page (.9)
      expect(worstAtPlate(oneBack)).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    });

    it('whatever it returns, reachable is exactly "the criterion is met"', () => {
      for (const [plateL, cmul, nameL, c] of cartesian(
        [0.2, 0.4, 0.5, 0.8],
        [0.25, 0.5, 1.5, 2],
        [0.3, 0.4, 0.5, 0.8],
        [0.025, 0.3],
      )) {
        const result = resolveNameAndPlate({ ...plateau, saved: { l: nameL, c, h: 0 }, plate: { l: plateL, cmul } });
        expect(result.reachable, JSON.stringify({ plateL, cmul, nameL, c, result })).toBe(
          result.worst >= NAME_ROLE_MIN_CONTRAST,
        );
      }
    });
  });

  describe('every field that moved is reported, also when nothing reads', () => {
    // The six edge colours a hex can have (the ring probe's own list) at the saturated end of the plate step, in a Light theme:
    // no plate lightness and no name lightness reads over every gradient, so the best case is drawn: the plate has run to the
    // page and the name sits at the best lightness it has there. (With the best case taken from every evaluated candidate this
    // is the only not-reached shape a 2000-case sweep produces; the Tuner hint renders the other flag combinations too, and its
    // own tests pin them with synthetic results.)
    const base = { colours: extremeColours, pages: lightPages, prefer: 'darker' as const };

    it('name and plate both moved, not reached', () => {
      const result = resolveNameAndPlate({ ...base, saved: { l: 0.4, c: 0.025, h: 144 }, plate: { l: 0.1, cmul: 2 } });

      expect(result).toMatchObject({ reachable: false, plateShifted: true, adjusted: true });
      expect(result.l).not.toBe(0.4);
      expect(result.worst).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    });
  });

  describe('the name moves too only when the plate alone cannot do it', () => {
    it('a saturated plate whose gradient dips under the criterion for the work-surface name: name and plate both move, and it reads', () => {
      // plate .2 / Cmul 1.5, saved name .4 / C .3 in the ordinary three-colour room: with the name held where the work surface
      // leaves it no plate lightness reads over the whole gradient, a much darker name does.
      const result = resolveNameAndPlate({
        saved: { l: 0.4, c: 0.3, h: 0 },
        plate: { l: 0.2, cmul: 1.5 },
        colours: regularColours,
        pages: lightPages,
        prefer: 'darker',
      });

      expect(result).toMatchObject({ reachable: true, plateShifted: true, adjusted: true });
      expect(result.l).toBeLessThan(0.4);
      expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
    });
  });

  describe('the brute force walks the way it says it does', () => {
    it('goes down as well as up, every step, ending exactly on the page', () => {
      const down = platesToward(0.65, 0.18375);
      const up = platesToward(0.1, 0.4);

      expect(down[0]).toBe(0.65);
      expect(down[1]).toBeCloseTo(0.64, 9);
      expect(down[40]).toBeCloseTo(0.25, 9);
      expect(down.at(-1)).toBe(0.18375);
      expect(down.length).toBe(48);
      expect(up.length).toBe(31);
      expect(up.every((p, i) => i === 0 || p > up[i - 1])).toBe(true);
      expect(down.every((p, i) => i === 0 || p < down[i - 1])).toBe(true);
    });
  });

  describe('completeness: "not reached" never hides something the resolver may move to (cloud #5086 rounds 1 to 3)', () => {
    // The same class of slip was found three times in three branches (a result judged by the headroom instead of the
    // criterion). So the claim is checked as a whole, against a brute force that shares none of the resolver's search logic:
    // every name lightness (step .01) at every plate lightness between the saved one and the work surface (step .01).
    const colourSets = [regularColours, spreadColours, extremeColours];
    const themes = [
      { pages: lightPages, prefer: 'darker' as const, plates: [0.1, 0.5, 0.8] },
      { pages: darkPages, prefer: 'lighter' as const, plates: [0.3, 0.5, 0.65] },
      // Mid-lightness layers with plates above them: nothing reads, and the walk goes DOWN toward the page.
      { pages: midPages, prefer: 'lighter' as const, plates: [0.7, 0.8, 0.9] },
    ];

    it('when it says not reached, no (name, plate) pair it could walk to meets the criterion', () => {
      const unreachable = new Map<(typeof themes)[number], number>();
      for (const [colours, theme, plateL, cmul, nameL, c] of cartesian(
        colourSets,
        themes,
        [0, 1, 2],
        [0.99, 2],
        [0.05, 0.4, 0.8],
        [0.025, 0.3],
      )) {
        const plate = { l: theme.plates[plateL], cmul };
        const input = { saved: { l: nameL, c, h: 144 }, plate, colours, pages: theme.pages, prefer: theme.prefer };
        const result = resolveNameAndPlate(input);
        if (result.reachable) continue;
        unreachable.set(theme, (unreachable.get(theme) ?? 0) + 1);
        const best = bruteBest(plate, colours, theme.pages, c);
        expect(best, JSON.stringify({ plate, nameL, c, result })).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
        // ...and what is reported and drawn as the best case really is the best the resolver may move to (codex-sol, round 5).
        expect(result.worst, JSON.stringify({ plate, nameL, c, result, best })).toBeGreaterThanOrEqual(best - 1e-9);
      }
      // The sweep reaches the not-reached state in a walk that goes up AND in one that goes down, or it proves nothing about them.
      expect(unreachable.get(themes[0])).toBeGreaterThan(0);
      expect(unreachable.get(themes[2])).toBeGreaterThan(0);
    });
  });

  describe('the best case is drawn and reported from every candidate that was evaluated (codex-sol and cloud #5086 round 5)', () => {
    it('keeps the best candidate of the moving-name pass: not 1.99:1 when 4.30:1 is available (codex-sol)', () => {
      const input = {
        saved: { l: 0.4, c: 0.025, h: 144 },
        plate: { l: 0.1, cmul: 2 },
        colours: extremeColours,
        pages: lightPages,
        prefer: 'darker' as const,
      };
      const result = resolveNameAndPlate(input);

      expect(result.reachable).toBe(false);
      expect(result.worst).toBeGreaterThan(4.3);
      expect(result.worst).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
      expect(result.worst).toBeGreaterThanOrEqual(bruteBest(input.plate, input.colours, input.pages, 0.025) - 1e-9);
    });

    it('same for the cloud example: about 4.46:1 is available, not the 3.63:1 of the work-surface name', () => {
      const input = {
        saved: { l: 0.617, c: 0.284, h: 100.4 },
        plate: { l: 0.696, cmul: 1.868 },
        colours: [{ h: 61.1, c: 0.286 }],
        pages: [{ l: 0.724, c: 0, h: 0, nameAlpha: 0.8 }],
        prefer: 'darker' as const,
      };
      const result = resolveNameAndPlate(input);

      expect(result.reachable).toBe(false);
      expect(result.worst).toBeGreaterThan(4.4);
      expect(result.worst).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    });
  });

  describe('the plate is not moved for nothing (cloud #5086 round 5)', () => {
    it('when the page itself caps the name below the headroom, the plate where it was saved is already the answer', () => {
      // Light, plate .614 / Cmul 1.033, saved name .072 / C .265 / H 251.7, one neutral page at .643 (the classic header draws
      // the name at 80% over it, which holds it at 4.52:1 whatever the plate does). Moving the plate by a step bought nothing.
      const result = resolveNameAndPlate({
        saved: { l: 0.072, c: 0.265, h: 251.7 },
        plate: { l: 0.614, cmul: 1.033 },
        colours: [{ h: 74.8, c: 0.0137 }],
        pages: [{ l: 0.643, c: 0, h: 0, nameAlpha: 0.8 }],
        prefer: 'darker',
      });

      expect(result).toMatchObject({ reachable: true, plateShifted: false, plateL: 0.614 });
      expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
      expect(result.worst).toBeLessThan(NAME_ROLE_TARGET_CONTRAST);
    });
  });
});
