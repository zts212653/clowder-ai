/* F322 B — which lightness the cat-name role is drawn at in a Tuner theme, and where the plate it sits on is drawn.
 * The saved lightness (catTextLightL / catTextDarkL) and the saved plate step are the user's and stay as saved; this decides
 * what buildCSS emits for `--cat-name-l` and `--cat-surface-l`. Both are resolved against what a name is drawn over in this
 * mode: the plate of every cat, connector and the human that really exist (the mode's surface step at their own colour) and
 * the mode's page layers. A name that reads is drawn as saved; when only the name can fix it, the nearest lightness that
 * reads; when no lightness reads against everything, the PLATE gives way (lib/readable-name-plate, Opus 5.5 3327 + 3619).
 * Without a catalogue (`actual` omitted) a swept range of colours stands in, as the fallback only. */

import {
  type ActualColours,
  type NamePlateResult,
  resolveNameAndPlate,
  SWEPT_PLATE_COLOURS,
} from '@/lib/readable-name-plate';
import { CLASSIC_NAME_OPACITY, type NameBackground, platesFor } from '@/lib/readable-name-role';
import { SURF_FACTORS, SURF_KEYS, type TunerState } from './oklch-tuner-engine';

export type { ActualColours };

/** The mode's page layers as colours; `nameAlpha` (when given) is how opaque a name is drawn over them. */
export function pageLayers(p: TunerState, dark: boolean, nameAlpha?: number): NameBackground[] {
  const mode = dark ? p.dark : p.light;
  const hue = p.surfaceHue ?? 80;
  const chroma = 0.01 * (p.surfaceChroma ?? 1);
  return SURF_KEYS.map((key, i) => ({
    l: mode.elev[key],
    c: +(chroma * SURF_FACTORS[i]).toFixed(4),
    h: hue,
    ...(nameAlpha === undefined ? {} : { nameAlpha }),
  }));
}

/** The swept backgrounds (the fallback): every plate colour of the sweep at the mode's step, and the page layers. */
export function nameBackgrounds(p: TunerState, dark: boolean): NameBackground[] {
  const mode = dark ? p.dark : p.light;
  // The page layers: the classic header draws the name over them at CLASSIC_NAME_OPACITY, so they are checked as drawn.
  return [...platesFor({ l: mode.surface.L, cmul: mode.surface.Cmul }), ...pageLayers(p, dark, CLASSIC_NAME_OPACITY)];
}

export function resolveTunerNameAndPlate(p: TunerState, dark: boolean, actual?: ActualColours): NamePlateResult {
  const mode = dark ? p.dark : p.light;
  return resolveNameAndPlate({
    saved: { l: dark ? p.catTextDarkL : p.catTextLightL, c: p.catTextC, h: p.catTextH },
    plate: { l: mode.surface.L, cmul: mode.surface.Cmul },
    colours: actual ? [...actual.cats, actual.human] : SWEPT_PLATE_COLOURS,
    pages: pageLayers(p, dark, CLASSIC_NAME_OPACITY),
    // Both sides open and about equally far: the direction this theme draws its text in.
    prefer: dark ? 'lighter' : 'darker',
  });
}

export function drawnNameLightness(p: TunerState, dark: boolean, actual?: ActualColours): number {
  return resolveTunerNameAndPlate(p, dark, actual).l;
}
