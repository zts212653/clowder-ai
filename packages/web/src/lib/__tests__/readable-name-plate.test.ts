import { describe, expect, it } from 'vitest';
import { platesOf, resolveNameAndPlate } from '../readable-name-plate';
import {
  NAME_ROLE_MIN_CONTRAST,
  NAME_ROLE_STEP,
  NAME_ROLE_TARGET_CONTRAST,
  readableNameLightness,
} from '../readable-name-role';
import {
  darkPages,
  everythingFor,
  lightPages,
  NAME,
  regularColours,
  spreadColours,
  worstOver,
} from './readable-name-plate-fixtures';

/**
 * F322 B follow-up (Opus 5.5 3327 + 3619): when no lightness of the name reads against everything it is drawn over, the
 * PLATE gives way and the name does not — the name first goes to the nearest value that reads on the work surface, then
 * the plate's lightness moves toward the work surface until the name reads; the plate's hue and chroma, and everything the
 * user saved, stay. Only when the work surface itself leaves no readable name is the best-case lightness drawn, and that is
 * reported as "not reached", never as a pass. The backgrounds are the ones that are really in the room: the cats and
 * connectors that exist and the human's configured colour, not a swept range of colours nobody has.
 */
describe('resolveNameAndPlate', () => {
  it('leaves everything as saved when the name already reads against the cats that exist', () => {
    const result = resolveNameAndPlate({
      saved: { l: 0.15, ...NAME },
      plate: { l: 0.85, cmul: 0.45 },
      colours: regularColours,
      pages: lightPages,
      prefer: 'darker',
    });

    expect(result).toMatchObject({ l: 0.15, plateL: 0.85, adjusted: false, plateShifted: false, reachable: true });
    expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
  });

  it('moves the name when the name alone can fix it, and leaves the plate where it was saved', () => {
    // A saved name that sits on the page colour: the nearest lightness that reads is darker, and no plate has to move.
    const result = resolveNameAndPlate({
      saved: { l: 0.9, ...NAME },
      plate: { l: 0.85, cmul: 0.45 },
      colours: regularColours,
      pages: lightPages,
      prefer: 'darker',
    });

    expect(result).toMatchObject({ adjusted: true, plateShifted: false, reachable: true, plateL: 0.85 });
    expect(result.l).toBeLessThan(0.9);
    expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
  });

  describe('when no lightness of the name reads against both the plates and the pages (Opus 3327 ¶1)', () => {
    const light = {
      saved: { l: 0.15, ...NAME },
      plate: { l: 0.55, cmul: 0.99 },
      colours: spreadColours,
      pages: lightPages,
      prefer: 'darker' as const,
    };

    it('is a real two-sided failure: the whole room leaves no readable name, the work surface alone does', () => {
      const room = readableNameLightness({
        l: light.saved.l,
        ...NAME,
        backgrounds: everythingFor(light.plate.l, light.plate.cmul, light.colours, light.pages),
        prefer: 'darker',
      });
      const work = readableNameLightness({ l: light.saved.l, ...NAME, backgrounds: lightPages, prefer: 'darker' });

      expect(room.reachable).toBe(false);
      expect(work.reachable).toBe(true);
    });

    it('keeps the name at the nearest value that reads on the work surface and moves the plate toward the work surface', () => {
      const result = resolveNameAndPlate(light);

      expect(result.reachable).toBe(true);
      expect(result.l).toBe(0.15); // it already reads on the work surface: the name does not give way
      expect(result.adjusted).toBe(false);
      expect(result.plateShifted).toBe(true);
      expect(result.plateL).toBeGreaterThan(0.55); // a light page: the plate moves lighter
      expect(result.plateL).toBeLessThan(0.95);
      expect(worstOver(result.l, everythingFor(result.plateL, 0.99, spreadColours, lightPages))).toBeGreaterThanOrEqual(
        NAME_ROLE_MIN_CONTRAST,
      );
    });

    it('moves the plate no further than it has to: one step back toward the saved value falls short', () => {
      const result = resolveNameAndPlate(light);
      const oneBack = Math.round((result.plateL - NAME_ROLE_STEP) * 10000) / 10000;

      expect(worstOver(result.l, everythingFor(oneBack, 0.99, spreadColours, lightPages))).toBeLessThan(
        NAME_ROLE_MIN_CONTRAST + 0.15,
      );
    });

    it('does the same in a dark theme: the plate moves darker, toward the dark page', () => {
      const result = resolveNameAndPlate({
        saved: { l: 0.88, ...NAME },
        plate: { l: 0.55, cmul: 0.99 },
        colours: spreadColours,
        pages: darkPages,
        prefer: 'lighter',
      });

      expect(result.reachable).toBe(true);
      expect(result.l).toBe(0.88);
      expect(result.plateShifted).toBe(true);
      expect(result.plateL).toBeLessThan(0.55);
      expect(worstOver(result.l, everythingFor(result.plateL, 0.99, spreadColours, darkPages))).toBeGreaterThanOrEqual(
        NAME_ROLE_MIN_CONTRAST,
      );
    });

    it('never touches the plate hue or chroma: the plates it measures are the same cats at a different lightness', () => {
      const result = resolveNameAndPlate(light);
      const before = platesOf(light.plate, spreadColours);
      const after = platesOf({ l: result.plateL, cmul: light.plate.cmul }, spreadColours);

      expect(after.map((p) => [p.c, p.h])).toEqual(before.map((p) => [p.c, p.h]));
    });
  });

  it('says "not reached" when even the work surface leaves no readable name, and draws the best case instead of passing it', () => {
    // Two page layers on opposite sides of the middle: no single name colour reads on both.
    const straddle = [
      { l: 0.15, c: 0.01, h: 80 },
      { l: 0.95, c: 0.01, h: 80 },
    ];
    const result = resolveNameAndPlate({
      saved: { l: 0.5, ...NAME },
      plate: { l: 0.85, cmul: 0.45 },
      colours: regularColours,
      pages: straddle,
      prefer: 'darker',
    });

    expect(result.reachable).toBe(false);
    expect(result.worst).toBeLessThan(NAME_ROLE_MIN_CONTRAST);
    expect(result.plateShifted).toBe(false);
    expect(result.plateL).toBe(0.85);
    expect(Number.isFinite(result.l)).toBe(true);
  });

  it('reports the number it could reach when the plate has moved as far as it can and the name still does not read', () => {
    // A plate whose own colours cannot be made readable by lightness alone in this chroma: chroma at the ceiling, cmul high.
    const result = resolveNameAndPlate({
      saved: { l: 0.15, ...NAME },
      plate: { l: 0.2, cmul: 2 },
      colours: [{ h: 264, c: 0.32 }],
      pages: lightPages,
      prefer: 'darker',
    });

    // Whatever happens, a result that is not a pass must not claim to be one.
    if (result.worst < NAME_ROLE_MIN_CONTRAST) expect(result.reachable).toBe(false);
    else expect(result.reachable).toBe(true);
  });

  describe('a name-alone best case without headroom', () => {
    it('does not pre-empt the plate: the plate is asked first, the name stays', () => {
      // Dark, saved name .88: the name alone could get to a bare-minimum white (the room's best case) but the plate can give
      // the name headroom, and the plate is the one that gives way.
      const result = resolveNameAndPlate({
        saved: { l: 0.88, ...NAME },
        plate: { l: 0.55, cmul: 0.99 },
        colours: spreadColours,
        pages: darkPages,
        prefer: 'lighter',
      });

      expect(result).toMatchObject({ l: 0.88, adjusted: false, plateShifted: true, reachable: true });
      expect(result.worst).toBeGreaterThanOrEqual(NAME_ROLE_TARGET_CONTRAST);
    });
  });

  it('is pure: the same inputs give the same answer and nothing it was given is changed', () => {
    const input = {
      saved: { l: 0.15, ...NAME },
      plate: { l: 0.55, cmul: 0.99 },
      colours: spreadColours,
      pages: lightPages,
      prefer: 'darker' as const,
    };
    const frozen = structuredClone(input);

    expect(resolveNameAndPlate(input)).toEqual(resolveNameAndPlate(input));
    expect(input).toEqual(frozen);
  });
});
