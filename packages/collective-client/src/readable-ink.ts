/**
 * F322 B — the ink for text written on a disc of the human colour (the nameplate's initial). A page token cannot promise it
 * reads: the host's primary can be light or dark, and so can the surface the initial used to borrow its colour from. So the ink
 * follows the fill: whichever of pure white or pure black has the higher WCAG contrast on it, never below 4.5:1 (the worst
 * fill, relative luminance 0.179, gives 4.58 either way; a softer near-black would not keep that, so the two inks are pure).
 *
 * The fill arrives over the appearance bridge as an opaque `#rrggbb`, so that is the only spelling read here. The Café has a
 * wider reader for the spellings its config accepts (`packages/web/src/lib/readable-ink.ts`); this one is the same rule for the
 * bridge's strict input.
 */
export const LIGHT_INK = '#ffffff';
export const DARK_INK = '#000000';

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return undefined;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => channel(Number.parseInt(part, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of one `#rrggbb` on another; `NaN` when either is not one. */
export function inkContrast(ink: string, fill: string): number {
  const a = luminance(ink);
  const b = luminance(fill);
  if (a === undefined || b === undefined) return Number.NaN;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The ink to write on an opaque `#rrggbb` fill, or `undefined` when the fill is not one (no guess). */
export function readableInkOn(fill: string): string | undefined {
  if (luminance(fill) === undefined) return undefined;
  return inkContrast(LIGHT_INK, fill) >= inkContrast(DARK_INK, fill) ? LIGHT_INK : DARK_INK;
}
