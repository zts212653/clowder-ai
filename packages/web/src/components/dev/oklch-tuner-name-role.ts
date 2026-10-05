/* F322 B — which lightness the cat-name role is drawn at in a Tuner theme.
 * The saved lightness (catTextLightL / catTextDarkL) is the user's and stays as saved; this decides what buildCSS emits for
 * `--cat-name-l`: the saved value when it reads against everything a name is drawn over in this mode, otherwise the nearest
 * lightness that does (lib/readable-name-role). A name is drawn over a cat's plate (the mode's surface step, at any cat
 * colour) and over the mode's page surfaces. */
import { CLASSIC_NAME_OPACITY, type NameBackground, platesFor, readableNameLightness } from '@/lib/readable-name-role';
import { SURF_FACTORS, SURF_KEYS, type TunerState } from './oklch-tuner-engine';

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

export function nameBackgrounds(p: TunerState, dark: boolean): NameBackground[] {
  const mode = dark ? p.dark : p.light;
  // The page layers: the classic header draws the name over them at CLASSIC_NAME_OPACITY, so they are checked as drawn.
  return [...platesFor({ l: mode.surface.L, cmul: mode.surface.Cmul }), ...pageLayers(p, dark, CLASSIC_NAME_OPACITY)];
}

export function drawnNameLightness(p: TunerState, dark: boolean): number {
  return readableNameLightness({
    l: dark ? p.catTextDarkL : p.catTextLightL,
    c: p.catTextC,
    h: p.catTextH,
    backgrounds: nameBackgrounds(p, dark),
    // Both sides open and about equally far: the direction this theme draws its text in.
    prefer: dark ? 'lighter' : 'darker',
  }).l;
}
