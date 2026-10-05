/**
 * F322 B — text drawn on an identity-colour fill (the owner avatar's "ME", an initial on a disc) has to read on the fill the
 * user configured. A theme token cannot promise that: in a dark theme both the surface and a dark cocoa fill are dark. So
 * the ink is chosen from the fill itself — whichever of pure white or pure black has the higher WCAG contrast on it, which
 * is never below 4.5:1 (the worst case, a fill of relative luminance 0.179, gives 4.58 either way; a softer near-black ink
 * would not keep that guarantee, so the inks are the two pure ones).
 */
import { parseHexColor } from './hex-color';

const LIGHT_INK = '#ffffff';
const DARK_INK = '#000000';

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an OPAQUE hex fill. A translucent one has no luminance of its own (the theme shows through). */
function luminance(hex: string): number | undefined {
  const parsed = parseHexColor(hex);
  if (!parsed || parsed.alpha < 1) return undefined;
  const [r, g, b] = parsed.rgb;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast of a hex ink on a hex fill; `NaN` when either is not a hex colour. */
export function inkContrast(ink: string, fill: string): number {
  const a = luminance(ink);
  const b = luminance(fill);
  if (a === undefined || b === undefined) return Number.NaN;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The ink to write on a hex fill, or `undefined` when the fill is not a painted opaque hex colour (no guess): not a hex at
 * all, or translucent - what shows through is the theme, which this function cannot see, so no claim is made for it.
 */
export function readableInkOn(fill: string): string | undefined {
  if (luminance(fill) === undefined) return undefined;
  return inkContrast(LIGHT_INK, fill) >= inkContrast(DARK_INK, fill) ? LIGHT_INK : DARK_INK;
}
