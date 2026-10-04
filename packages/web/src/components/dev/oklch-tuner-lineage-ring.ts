/* F322 B — which lightness the lineage ring is drawn at in a Tuner theme.
 * `[data-lineage-focus]` is the ~3 second ring that lands on the message a receipt or an absorption dock points back to
 * (globals.css). It is a non-text mark, so its criterion is 3:1 against what it sits on. It keeps the human's hue and
 * chroma (the user's config, known only at run time) and only has its lightness floored at display time: the bubble
 * lightness as saved when that already reads, otherwise the nearest lightness that does (lib/readable-name-role, with the 3:1
 * criterion and the headroom the name role has). One value per mode, so the ring looks the same wherever it lands.
 *
 * The colours on both sides are the user's, so the check covers the whole legal range, not a sample: the ring is any hue at
 * any chroma an sRGB hex can have (times the bubble multiplier), and it can land on a plate of any cat colour (times the
 * plate step's multiplier) or on a page layer. For a given lightness the worst case of such a range is a statement about
 * luminance intervals: the ring's colours span [Rmin, Rmax], the plate's [Pmin, Pmax], each layer is a point, and the
 * contrast of two intervals is 1 if they overlap, otherwise the gap between their nearest ends. The intervals come from a
 * 2 degree / five-chroma grid whose extremes a 1 degree / 0.01 grid does not exceed by more than a tenth of a contrast point
 * (oklch-tuner-lineage-ring.test.ts), over the whole range the Tuner allows for the chroma multiplier (0 to 2). */
import { linearRgbLuminance, oklchToClippedLinearRgb } from '@/lib/color-utils';
import { NAME_ROLE_MIN_CONTRAST, NAME_ROLE_TARGET_CONTRAST, readableNameLightness } from '@/lib/readable-name-role';
import type { TunerState } from './oklch-tuner-engine';
import { pageLayers } from './oklch-tuner-name-role';

/** WCAG 1.4.11: the mark against what is next to it. */
export const LINEAGE_RING_MIN_CONTRAST = 3;
/** The headroom the name role searches with over its criterion (4.65 vs 4.5). */
const HEADROOM = NAME_ROLE_TARGET_CONTRAST - NAME_ROLE_MIN_CONTRAST;
/** What the search aims for: the criterion plus the headroom, so rounding never dips under 3:1. */
export const LINEAGE_RING_TARGET_CONTRAST = LINEAGE_RING_MIN_CONTRAST + HEADROOM;

/** No sRGB hex colour has a higher OKLCH chroma (the maximum is about 0.322, magenta). */
export const LINEAGE_RING_MAX_CHROMA = 0.33;
const HUE_STEP = 2;
/** Luminance moves one way with chroma at a fixed lightness and hue; the in-between chromas are a check on that, not a need. */
const CHROMA_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

export interface LuminanceRange {
  min: number;
  max: number;
}

/** The luminance range of every colour at lightness `l`, any hue, any chroma up to the ceiling, times `cmul`. */
export function luminanceRange(l: number, cmul: number): LuminanceRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let h = 0; h < 360; h += HUE_STEP) {
    for (const fraction of CHROMA_FRACTIONS) {
      const y = linearRgbLuminance(oklchToClippedLinearRgb({ l, c: fraction * LINEAGE_RING_MAX_CHROMA * cmul, h }));
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }
  return { min, max };
}

/** Contrast of the worst pair drawn from two luminance ranges: 1 when they overlap, otherwise the gap between them. */
function rangeContrast(a: LuminanceRange, b: LuminanceRange): number {
  if (a.max >= b.min && b.max >= a.min) return 1;
  const [lighter, darker] = a.min > b.max ? [a.min, b.max] : [b.min, a.max];
  return (lighter + 0.05) / (darker + 0.05);
}

/** What the ring can land on in this mode, as luminance ranges: the plate of any cat colour, and each page layer. */
function landingRanges(p: TunerState, dark: boolean): LuminanceRange[] {
  const mode = dark ? p.dark : p.light;
  const layers = pageLayers(p, dark).map((layer) => {
    const y = linearRgbLuminance(oklchToClippedLinearRgb(layer));
    return { min: y, max: y };
  });
  return [luminanceRange(mode.surface.L, mode.surface.Cmul), ...layers];
}

function ringCmul(p: TunerState, dark: boolean): number {
  return (dark ? p.dark : p.light).primary.Cmul;
}

/** The worst contrast, over every ring colour and everything it can land on, of the ring drawn at lightness `l`. */
export function lineageRingWorstContrast(p: TunerState, dark: boolean, l: number): number {
  const ring = luminanceRange(l, ringCmul(p, dark));
  return Math.min(...landingRanges(p, dark).map((landing) => rangeContrast(ring, landing)));
}

export function lineageRingLightness(p: TunerState, dark: boolean) {
  const mode = dark ? p.dark : p.light;
  const landings = landingRanges(p, dark);
  const cmul = ringCmul(p, dark);
  return readableNameLightness({
    // The ring has always been drawn in the bubble role (--color-cocreator-primary): its saved lightness is the bubble's.
    l: mode.primary.L,
    c: 0,
    h: 0,
    contrastAt: (candidate) => {
      const ring = luminanceRange(candidate, cmul);
      return Math.min(...landings.map((landing) => rangeContrast(ring, landing)));
    },
    prefer: dark ? 'lighter' : 'darker',
    minimum: LINEAGE_RING_MIN_CONTRAST,
    target: LINEAGE_RING_TARGET_CONTRAST,
  });
}
