/**
 * F322 B — keeping the cat-name role readable in the theme the user saved.
 *
 * DESIGN.md「对话」: a cat's name, against whatever really sits behind it in the current theme, reads at >= 4.5:1. The
 * Tuner lets the name role be set anywhere (lightness 0..1), and one theme-wide value paints every cat's name, so a saved
 * value can sit on top of the plate colour or the page colour it is drawn over. The role is the user's choice and the
 * saved value is never rewritten; this module only decides which lightness is *drawn*.
 *
 * Pure and deterministic: the saved lightness when it already reads, otherwise the nearest lightness that does. The hue
 * and chroma are the user's and are not inputs the function can change. No fixed black/white: the side is whichever one
 * the theme's own backgrounds leave open, and when both are open and about equally far, the direction the theme draws its
 * text in (light themes darker, dark themes lighter), so a slider dragged around the middle does not make the name jump.
 *
 * Note on that tie rule: a darker name needs the background's luminance Yb >= .05R - .05 and a lighter one needs
 * Yb <= 1.05/R - .05, and those two stop overlapping once R > sqrt(21) = 4.58. With the headroom in the target (4.65) no
 * single background leaves both sides open, so the rule is the specified behaviour and a guard, not something that fires
 * in practice; the tests exercise it with a lower target, where a narrow window exists.
 */
import { linearRgbLuminance, type OklchColor, oklchToClippedLinearRgb } from './color-utils';

export const NAME_ROLE_MIN_CONTRAST = 4.5;
/** Headroom over the criterion for a value the search picks, so 8-bit rounding never dips a drawn name under 4.5. */
const MARGIN = 0.15;
/** What a drawn name is searched for: the criterion plus the headroom. */
export const NAME_ROLE_TARGET_CONTRAST = NAME_ROLE_MIN_CONTRAST + MARGIN;
export const NAME_ROLE_STEP = 0.005;
const STEP = NAME_ROLE_STEP;
/** Both sides read and their distances from the saved value differ by no more than this: take the theme's own direction. */
const TIE = 0.05;
const UNKNOWN_START = 0.5;

/** The classic message header draws the cat name at this opacity (ChatMessage), over the page. */
export const CLASSIC_NAME_OPACITY = 0.8;

/** The hues, and the cat chromas, a plate is swept over: cats bring their own colour, the theme only brings L and Cmul. */
const PLATE_HUES = Array.from({ length: 12 }, (_, i) => i * 30);
const PLATE_CHROMAS = [0, 0.05, 0.1, 0.15, 0.2];

/** Every plate colour a cat can put under a name for this surface step (`--color-{cat}-surface` = L, cat chroma x Cmul). */
export function platesFor(step: { l: number; cmul: number }): OklchColor[] {
  const plates: OklchColor[] = [];
  for (const h of PLATE_HUES) for (const chroma of PLATE_CHROMAS) plates.push({ l: step.l, c: chroma * step.cmul, h });
  return plates;
}

/** Something a name is drawn over. `nameAlpha` is how opaque the name is drawn there (default: fully). */
export type NameBackground = OklchColor & { nameAlpha?: number };

const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

interface PreparedBackground {
  linear: [number, number, number];
  luminance: number;
  alpha: number;
}

function prepare(bg: NameBackground): PreparedBackground {
  const linear = oklchToClippedLinearRgb(bg);
  return { linear, luminance: linearRgbLuminance(linear), alpha: Math.max(0, Math.min(1, bg.nameAlpha ?? 1)) };
}

/** WCAG contrast of a foreground (already in linear sRGB) over a prepared background, as it is drawn. */
function contrastOn(fgLinear: [number, number, number], bg: PreparedBackground): number {
  const drawn =
    bg.alpha >= 1
      ? fgLinear
      : (fgLinear.map((v, i) => toLinear(toSrgb(v) * bg.alpha + toSrgb(bg.linear[i]) * (1 - bg.alpha))) as [
          number,
          number,
          number,
        ]);
  const a = linearRgbLuminance(drawn);
  const [light, dark] = a > bg.luminance ? [a, bg.luminance] : [bg.luminance, a];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * WCAG contrast of a name against one background, as it is drawn: a name at less than full opacity is blended with the
 * background in sRGB (the way the browser composites opacity) before its luminance is taken.
 */
export function nameContrast(fg: OklchColor, bg: NameBackground): number {
  return contrastOn(oklchToClippedLinearRgb(fg), prepare(bg));
}

export interface ReadableNameLightness {
  /** The lightness to draw the name at. */
  l: number;
  /** The saved lightness did not read against every background (or was not a usable number). */
  adjusted: boolean;
  /** Some lightness reads against every background. When false, `l` is the best the theme leaves, not a pass. */
  reachable: boolean;
}

interface Args {
  /** The saved lightness of the name role. */
  l: number;
  c: number;
  h: number;
  /** Everything the name is drawn over in this theme (not needed when `contrastAt` is given). */
  backgrounds?: readonly NameBackground[];
  /** The direction this theme draws its text in; decides when both sides read and are about equally far. */
  prefer?: 'darker' | 'lighter';
  /** What a drawn name is searched for. Defaults to the criterion plus its headroom. */
  target?: number;
  /**
   * The criterion a saved value is kept at (default: the name role's 4.5). A mark that is not text has a lower one (3:1);
   * the search still aims for `target`, so the headroom only applies to a value the search picks.
   */
  minimum?: number;
  /**
   * The contrast of a candidate lightness, when the caller can compute it better than a list of background colours can: a
   * mark whose own colour and whose neighbours are a whole range (the lineage ring: any human hue and chroma over any cat
   * plate) states the worst case of that range directly. When given it replaces the pairwise search over `backgrounds`.
   */
  contrastAt?: (candidate: number) => number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/* Candidates are rounded to what is emitted into CSS, so the lightness that was checked is the one that is drawn. */
const candidateAt = (x: number) => Math.round(clamp01(x) * 10000) / 10000;
const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

export function readableNameLightness({
  l,
  c,
  h,
  backgrounds = [],
  prefer = 'darker',
  target = NAME_ROLE_TARGET_CONTRAST,
  minimum = NAME_ROLE_MIN_CONTRAST,
  contrastAt,
}: Args): ReadableNameLightness {
  const chroma = Math.max(0, finite(c, 0));
  const hue = finite(h, 0);
  // The backgrounds do not change while the search walks the lightness: convert them once.
  const prepared = backgrounds.map(prepare);
  const pairwise = (candidate: number) => {
    if (prepared.length === 0) return Number.POSITIVE_INFINITY;
    const fg = oklchToClippedLinearRgb({ l: candidate, c: chroma, h: hue });
    let lowest = Number.POSITIVE_INFINITY;
    for (const bg of prepared) lowest = Math.min(lowest, contrastOn(fg, bg));
    return lowest;
  };
  const worst = contrastAt ?? pairwise;

  const known = Number.isFinite(l);
  const saved = clamp01(known ? l : UNKNOWN_START);
  // A saved value that already meets the criterion is drawn as saved. The headroom is only for the value the search
  // picks: a value that reads is not rewritten for being short of the headroom (DESIGN.md: reads -> drawn = saved).
  if (known && worst(saved) >= Math.min(target, minimum)) {
    return { l: saved, adjusted: false, reachable: true };
  }

  // The nearest lightness that reads on each side of the saved value.
  const steps = Math.round(1 / STEP);
  const nearest = (direction: -1 | 1) => {
    for (let k = 1; k <= steps; k++) {
      const candidate = candidateAt(saved + direction * k * STEP);
      if (worst(candidate) >= target) return { candidate, distance: Math.abs(candidate - saved) };
      if (candidate === 0 || candidate === 1) break;
    }
    return undefined;
  };
  const darker = nearest(-1);
  const lighter = nearest(1);
  if (darker || lighter) {
    if (!darker || !lighter) return { l: (darker ?? lighter)!.candidate, adjusted: true, reachable: true };
    const aboutEqual = Math.abs(darker.distance - lighter.distance) <= TIE + 1e-9;
    const pick = aboutEqual
      ? prefer === 'darker'
        ? darker
        : lighter
      : darker.distance < lighter.distance
        ? darker
        : lighter;
    return { l: pick.candidate, adjusted: true, reachable: true };
  }

  // No lightness reads against everything: the best one the theme leaves (nearest to the saved value on a tie).
  let bestL = saved;
  let bestRatio = worst(saved);
  for (let k = 0; k <= steps; k++) {
    for (const candidate of [candidateAt(saved - k * STEP), candidateAt(saved + k * STEP)]) {
      const ratio = worst(candidate);
      if (ratio > bestRatio + 1e-9) {
        bestRatio = ratio;
        bestL = candidate;
      }
    }
  }
  return { l: bestL, adjusted: true, reachable: false };
}
