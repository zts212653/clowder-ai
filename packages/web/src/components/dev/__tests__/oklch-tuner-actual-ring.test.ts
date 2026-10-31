import { describe, expect, it } from 'vitest';
import { platesOf } from '@/lib/readable-name-plate';
import { nameContrast } from '@/lib/readable-name-role';
import { buildCSS } from '../oklch-tuner-css';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '../oklch-tuner-engine';
import { LINEAGE_RING_MIN_CONTRAST, lineageRingLightness } from '../oklch-tuner-lineage-ring';
import { type ActualColours, pageLayers, resolveTunerNameAndPlate } from '../oklch-tuner-name-role';

/**
 * F322 B follow-up (Opus 5.5 3619): the lineage ring is resolved the way the name is — against the colours that really
 * exist, not "one value for the whole legal range". Sol's counterexample (a human #00ff00 and a cat #ff00ff in the
 * catalogue) must pass; an ordinary catalogue brings the ring close to the saved value; an extreme cat added to the
 * catalogue is seen.
 */
const NO_HC = { on: false, hue: 0, chroma: 0 };
const REGULAR_CATS = [
  { h: 250, c: 0.12 },
  { h: 25, c: 0.15 },
  { h: 145, c: 0.1 },
  { h: 300, c: 0.14 },
  { h: 60, c: 0.13 },
];
const COCOA = { h: 58, c: 0.04 };
const REGULAR: ActualColours = { cats: REGULAR_CATS, human: COCOA };
/** #00ff00 and #ff00ff in OKLCH (hue / chroma as CatHueInjector would read them). */
const GREEN = { h: 142.5, c: 0.295 };
const MAGENTA = { h: 328.4, c: 0.314 };
const SOL: ActualColours = { cats: [...REGULAR_CATS, MAGENTA], human: GREEN };

const themes: Array<[string, TunerState]> = [
  ['INIT_LIGHT', INIT_LIGHT],
  ['INIT_DARK', INIT_DARK],
];

/** The ring, as drawn, against every landing in the room: the plates as drawn and the page layers. */
function worstRingContrast(p: TunerState, dark: boolean, actual: ActualColours, ringL: number): number {
  const mode = dark ? p.dark : p.light;
  const { plateL } = resolveTunerNameAndPlate(p, dark, actual);
  const ring = { l: ringL, c: actual.human.c * mode.primary.Cmul, h: actual.human.h };
  const landings = [
    ...platesOf({ l: plateL, cmul: mode.surface.Cmul }, [...actual.cats, actual.human]),
    ...pageLayers(p, dark),
  ];
  return Math.min(...landings.map((landing) => nameContrast(ring, landing)));
}

describe('lineageRingLightness with the colours that exist', () => {
  for (const [label, base] of themes) {
    for (const dark of [false, true]) {
      const mode = dark ? 'dark' : 'light';

      it(`passes Sol's counterexample (human #00ff00, a #ff00ff cat in the catalogue): ${label} ${mode} reads at 3:1 everywhere`, () => {
        const ring = lineageRingLightness(base, dark, SOL);

        expect(ring.reachable).toBe(true);
        expect(worstRingContrast(base, dark, SOL, ring.l)).toBeGreaterThanOrEqual(LINEAGE_RING_MIN_CONTRAST);
      });
    }
  }

  it('with an ordinary catalogue the ring stays close to the saved lightness, and Dark often exactly at it', () => {
    for (const [, base] of themes) {
      for (const dark of [false, true]) {
        const saved = (dark ? base.dark : base.light).primary.L;
        const ring = lineageRingLightness(base, dark, REGULAR);

        expect(Math.abs(ring.l - saved)).toBeLessThanOrEqual(0.1);
        expect(worstRingContrast(base, dark, REGULAR, ring.l)).toBeGreaterThanOrEqual(LINEAGE_RING_MIN_CONTRAST);
      }
    }
    expect(lineageRingLightness(INIT_LIGHT, true, REGULAR)).toMatchObject({
      l: INIT_LIGHT.dark.primary.L,
      adjusted: false,
    });
  });

  it('asks less of the ring than the whole-range answer did, because the colours nobody has no longer count', () => {
    const range = lineageRingLightness(INIT_LIGHT, false).l; // the fallback: the legal range
    const actual = lineageRingLightness(INIT_LIGHT, false, REGULAR).l;

    expect(Math.abs(actual - INIT_LIGHT.light.primary.L)).toBeLessThan(Math.abs(range - INIT_LIGHT.light.primary.L));
  });

  it('recomputes when an extreme cat joins the catalogue and when the human colour changes', () => {
    const base = lineageRingLightness(INIT_LIGHT, false, REGULAR).l;
    const withMagenta = lineageRingLightness(INIT_LIGHT, false, { ...REGULAR, cats: [...REGULAR_CATS, MAGENTA] }).l;
    const greenHuman = lineageRingLightness(INIT_LIGHT, false, { ...REGULAR, human: GREEN }).l;

    expect(withMagenta).not.toBe(base);
    expect(greenHuman).not.toBe(base);
    // and back: it is a pure function of what is in the room
    expect(lineageRingLightness(INIT_LIGHT, false, REGULAR).l).toBe(base);
  });

  it('is measured against the plate as it is drawn, after the plate has given way', () => {
    const p = structuredClone(INIT_LIGHT);
    p.light.surface = { L: 0.4, Cmul: 0.99 };
    const role = resolveTunerNameAndPlate(p, false, REGULAR);
    expect(role.plateShifted).toBe(true);

    const ring = lineageRingLightness(p, false, REGULAR);
    expect(worstRingContrast(p, false, REGULAR, ring.l)).toBeGreaterThanOrEqual(LINEAGE_RING_MIN_CONTRAST);
  });

  it('puts the actual ring lightness in the generated CSS', () => {
    const css = buildCSS(INIT_LIGHT, NO_HC, SOL);
    const light = css.split('}').find((rule) => rule.trimStart().startsWith(':root{--cat-bubble-l'));

    expect(Number(light?.match(/--cat-lineage-l:([^;}]+)/)?.[1])).toBe(lineageRingLightness(INIT_LIGHT, false, SOL).l);
  });
});
