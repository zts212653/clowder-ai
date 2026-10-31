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
export const PLATE_HUES = Array.from({ length: 12 }, (_, i) => i * 30);
export const PLATE_CHROMAS = [0, 0.05, 0.1, 0.15, 0.2];

/** Every plate colour a cat can put under a name for this surface step (`--color-{cat}-surface` = L, cat chroma x Cmul). */
export function platesFor(step: { l: number; cmul: number }): OklchColor[] {
  const plates: OklchColor[] = [];
  for (const h of PLATE_HUES) for (const chroma of PLATE_CHROMAS) plates.push({ l: step.l, c: chroma * step.cmul, h });
  return plates;
}

/** Something a name is drawn over. `nameAlpha` is how opaque the name is drawn there (default: fully). */
export type NameBackground = OklchColor & { nameAlpha?: number };

/**
 * What is behind a name along a gradient from one surface into another (the nameplate paints `linear-gradient(surface,
 * transparent)` over the page): not a list of colours but every luminance in [low, high], exactly (see gradientBackground).
 */
export interface GradientBackground {
  gradient: { low: number; high: number };
}
export type AnyBackground = NameBackground | GradientBackground;

const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** A colour behind the name (opaque or not), or every luminance of a gradient. */
type PreparedBackground =
  | { kind: 'colour'; linear: [number, number, number]; luminance: number; alpha: number }
  | { kind: 'gradient'; low: number; high: number };

function prepare(bg: AnyBackground): PreparedBackground {
  if ('gradient' in bg) return { kind: 'gradient', low: bg.gradient.low, high: bg.gradient.high };
  const linear = oklchToClippedLinearRgb(bg);
  return {
    kind: 'colour',
    linear,
    luminance: linearRgbLuminance(linear),
    alpha: Math.max(0, Math.min(1, bg.nameAlpha ?? 1)),
  };
}

/** Iterations of the ternary search below: the bracket shrinks by 2/3 each time, (2/3)^40 is under 1e-7. */
const GRADIENT_SEARCH_STEPS = 40;

/**
 * Every luminance behind a name along a `linear-gradient(top, transparent)` laid over `under`, as the browser blends it: in
 * sRGB, not in linear light. The blend is a straight line in sRGB and the luminance is a sum of the (convex) sRGB-to-linear
 * curves along it, so it is convex in the position t: its highest value is at one of the two ends and its lowest is found by
 * a ternary search. Together that is the whole interval, exactly, with no sparse sampling. A text whose luminance falls inside
 * the interval has some point of the gradient where it reads at 1:1, so it must be outside by the criterion's margin.
 */
export function gradientBackground(top: OklchColor, under: OklchColor): GradientBackground {
  const a = oklchToClippedLinearRgb(top).map(toSrgb);
  const b = oklchToClippedLinearRgb(under).map(toSrgb);
  const luminanceAt = (t: number) =>
    linearRgbLuminance(a.map((v, i) => toLinear(v * t + b[i] * (1 - t))) as [number, number, number]);
  let from = 0;
  let to = 1;
  for (let step = 0; step < GRADIENT_SEARCH_STEPS; step++) {
    const first = from + (to - from) / 3;
    const second = to - (to - from) / 3;
    if (luminanceAt(first) < luminanceAt(second)) to = second;
    else from = first;
  }
  const ends = [luminanceAt(0), luminanceAt(1)];
  return { gradient: { low: Math.min(...ends, luminanceAt((from + to) / 2)), high: Math.max(...ends) } };
}

const contrastBetween = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The lowest contrast of a text of luminance `own` over every luminance in [low, high]: 1:1 inside it, else at the nearer end. */
function contrastOverRange(own: number, low: number, high: number): number {
  if (own >= low && own <= high) return 1;
  return contrastBetween(own, own < low ? low : high);
}

/** WCAG contrast of a foreground (already in linear sRGB) over a prepared background, as it is drawn. */
function contrastOn(fgLinear: [number, number, number], bg: PreparedBackground): number {
  if (bg.kind === 'gradient') return contrastOverRange(linearRgbLuminance(fgLinear), bg.low, bg.high);
  const drawn =
    bg.alpha >= 1
      ? fgLinear
      : (fgLinear.map((v, i) => toLinear(toSrgb(v) * bg.alpha + toSrgb(bg.linear[i]) * (1 - bg.alpha))) as [
          number,
          number,
          number,
        ]);
  return contrastBetween(linearRgbLuminance(drawn), bg.luminance);
}

/**
 * WCAG contrast of a name against one background, as it is drawn: a name at less than full opacity is blended with the
 * background in sRGB (the way the browser composites opacity) before its luminance is taken.
 */
export function nameContrast(fg: OklchColor, bg: AnyBackground): number {
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
  backgrounds?: readonly AnyBackground[];
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

/** Merge luminance intervals into disjoint, sorted ones: what is present behind the glyph, as a set. */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [low, high] of [...intervals].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && low <= last[1]) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

/**
 * The lowest contrast of a text of luminance `own` over a set of opaque luminances given as merged intervals (a plain
 * background is a zero-width one, a gradient is a wide one). Inside any of them it is 1:1; otherwise only the nearest interval
 * above and the nearest one below can be the lowest, found by a binary search.
 */
function lowestOverIntervals(merged: ReadonlyArray<[number, number]>, own: number): number {
  let low = 0;
  let high = merged.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (merged[mid][1] < own) low = mid + 1;
    else high = mid;
  }
  if (low < merged.length && merged[low][0] <= own) return 1;
  const above = low < merged.length ? contrastBetween(own, merged[low][0]) : Number.POSITIVE_INFINITY;
  const below = low > 0 ? contrastBetween(own, merged[low - 1][1]) : Number.POSITIVE_INFINITY;
  return Math.min(above, below);
}

/**
 * The worst contrast of a name (this chroma and hue) over `backgrounds`, as a function of the name's lightness. Prepared once
 * for the whole walk. Fully opaque names are answered from the merged luminance intervals (the same numbers as a pass over
 * every background, in O(log n), and exact over a gradient). A name drawn at less than full opacity takes on what is behind
 * it, so those backgrounds are checked one by one.
 */
export function worstContrastFor(backgrounds: readonly AnyBackground[], c: number, h: number): (l: number) => number {
  const chroma = Math.max(0, finite(c, 0));
  const hue = finite(h, 0);
  const prepared = backgrounds.map(prepare);
  const opaque: Array<[number, number]> = [];
  const blended: PreparedBackground[] = [];
  for (const bg of prepared) {
    if (bg.kind === 'gradient') opaque.push([bg.low, bg.high]);
    else if (bg.alpha >= 1) opaque.push([bg.luminance, bg.luminance]);
    else blended.push(bg);
  }
  const merged = mergeIntervals(opaque);
  return (candidate) => {
    if (prepared.length === 0) return Number.POSITIVE_INFINITY;
    const fg = oklchToClippedLinearRgb({ l: candidate, c: chroma, h: hue });
    let lowest = merged.length > 0 ? lowestOverIntervals(merged, linearRgbLuminance(fg)) : Number.POSITIVE_INFINITY;
    for (const bg of blended) lowest = Math.min(lowest, contrastOn(fg, bg));
    return lowest;
  };
}

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
  const worst = contrastAt ?? worstContrastFor(backgrounds, c, h);

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
  // The headroom is what the search aims for, not what a pass is: a best case at or above the criterion reads. Reported
  // honestly either way, so the state and the number it carries can never contradict ("4.52:1, not reached").
  return { l: bestL, adjusted: bestL !== saved, reachable: bestRatio >= minimum };
}
