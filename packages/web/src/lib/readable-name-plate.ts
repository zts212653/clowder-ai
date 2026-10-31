/**
 * F322 B follow-up — the cat-name role and the plate it sits on, resolved against what is really in the room.
 *
 * Opus 5.5 (3327 + 3619). The name is information and the plate is decoration, so when no lightness of the name reads
 * against everything it is drawn over, the PLATE gives way:
 *   1. The name first goes to the nearest lightness that reads on the work surface (the page layers), the way it always
 *      did (readable-name-role).
 *   2. Then, at display time, the plate's lightness moves toward the work surface — only its lightness; its hue, its
 *      chroma and everything the user saved stay — until the name reads on every plate.
 *   3. Only when the work surface itself leaves no readable name is the best case drawn, and that is reported as not
 *      reached, never as a pass. If the plate has moved as far as it can and the name still does not read, that is
 *      reported the same way, with the number it did reach.
 * Where both sides read, nothing moves: a name that already reads is drawn as saved and the plate is where it was saved.
 *
 * "Everything it is drawn over" is the surfaces that really exist in the current configuration — the cats and connectors
 * in the catalogue and the human's configured colour, each at the theme's plate step — plus the page layers. Not a swept
 * range of colours nobody has: a fluorescent magenta cat that is not in the catalogue does not decide what everyone sees.
 * One value per mode, so a name and a plate look the same wherever they are drawn; when the catalogue or a colour changes
 * the caller resolves again.
 *
 * Pure and deterministic. Nothing it is given is changed.
 */
import type { OklchColor } from './color-utils';
import {
  type AnyBackground,
  gradientBackground,
  NAME_ROLE_MIN_CONTRAST,
  NAME_ROLE_STEP,
  NAME_ROLE_TARGET_CONTRAST,
  type NameBackground,
  PLATE_CHROMAS,
  PLATE_HUES,
  type ReadableNameLightness,
  readableNameLightness,
  worstContrastFor,
} from './readable-name-role';

/** What a cat, a connector or the human brings to a plate: its own hue and chroma, before the theme's plate multiplier. */
export interface ActualPlateColour {
  h: number;
  c: number;
}

/** The theme's plate step: one lightness and one chroma multiplier for every plate (`--cat-surface-l` / `-cmul`). */
export interface PlateStep {
  l: number;
  cmul: number;
}

/** Every plate that really exists for this step: each colour at the step's lightness and chroma multiplier. */
export function platesOf(step: PlateStep, colours: readonly ActualPlateColour[]): OklchColor[] {
  return colours.map(({ h, c }) => ({ l: step.l, c: c * step.cmul, h }));
}

/**
 * Everything a name is drawn over for this plate step: the plates, the page layers, and, for each plate over each page layer,
 * the gradient between them. The nameplate paints `linear-gradient(surface, transparent)` over the page, so behind the glyphs
 * there is every sRGB blend between the two, and a name that reads on both ends can still dip under the criterion inside it
 * (cloud review #5086, rounds 2 and 4). The gradient is taken exactly, as the interval of luminances it spans
 * (readable-name-role `gradientBackground`), not as a handful of sample points. Colours that repeat (several connectors share
 * one neutral) are checked once.
 */
export function surfacesUnderName(
  step: PlateStep,
  colours: readonly ActualPlateColour[],
  pages: readonly NameBackground[],
): AnyBackground[] {
  const unique = [...new Map(colours.map((colour) => [`${colour.h}:${colour.c}`, colour])).values()];
  const plates = platesOf(step, unique);
  const gradients = plates.flatMap((plate) => pages.map((page) => gradientBackground(plate, page)));
  return [...plates, ...pages, ...gradients];
}

/**
 * A swept range of colours (12 hues x 5 chromas): only the FALLBACK for when nothing is known about the room yet (no
 * catalogue has arrived, a Tuner preview without data). Once the cats are known, the colours that exist replace it.
 */
export const SWEPT_PLATE_COLOURS: readonly ActualPlateColour[] = PLATE_HUES.flatMap((h) =>
  PLATE_CHROMAS.map((c) => ({ h, c })),
);

/** The colours that really exist in this room: the cats and connectors in the catalogue, and the human's. */
export interface ActualColours {
  cats: readonly ActualPlateColour[];
  human: ActualPlateColour;
}

export interface NamePlateInput {
  /** The saved name role (lightness is the one being resolved; hue and chroma are the user's and are never changed). */
  saved: { l: number; c: number; h: number };
  plate: PlateStep;
  colours: readonly ActualPlateColour[];
  /** The page layers the name is drawn over, each with the opacity the name is drawn at over it. */
  pages: readonly NameBackground[];
  /** The direction this theme draws its text in; decides when both sides of the saved value read and are about equally far. */
  prefer: 'darker' | 'lighter';
}

export interface NamePlateResult extends ReadableNameLightness {
  /** The plate lightness to draw (`--cat-surface-l`): the saved one unless the plate gave way. */
  plateL: number;
  /** The plate was moved from its saved lightness. */
  plateShifted: boolean;
  /** The lowest contrast of the drawn name over everything it is drawn over, as drawn (plates at `plateL`, pages as given). */
  worst: number;
}

/* Candidates are rounded to what is emitted into CSS, so the lightness that was checked is the one that is drawn. */
const round4 = (x: number) => Math.round(x * 10000) / 10000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

type RoleArgs = { l: number; c: number; h: number; prefer: 'darker' | 'lighter' };

/** The plate lightnesses the plate can be walked to, one step at a time, from its saved one toward the work surface. */
function plateWalk(plate: PlateStep, pages: readonly NameBackground[]): number[] {
  const pageL = pages.reduce((sum, page) => sum + page.l, 0) / pages.length;
  const direction = pageL >= plate.l ? 1 : -1;
  const limit = round4(clamp01(pageL));
  const candidates: number[] = [];
  for (let k = 1; ; k++) {
    const raw = plate.l + direction * k * NAME_ROLE_STEP;
    const candidate = round4(direction > 0 ? Math.min(raw, limit) : Math.max(raw, limit));
    candidates.push(candidate);
    if (candidate === limit) break;
  }
  return candidates;
}

/** One candidate of a walk, judged as it would be drawn. */
interface Evaluated {
  plateL: number;
  l: number;
  adjusted: boolean;
  /** The lowest contrast of the name at `l` over everything behind it with the plate at `plateL`. */
  worst: number;
}

/**
 * The acceptance rule, in one place. Cloud review rounds 1 to 3 each found the same slip in a different branch: a result judged
 * by the search headroom (4.65) instead of by the criterion (4.5). So there is exactly one rule, and every walk uses it:
 *   - a candidate PASSES when its worst contrast is >= NAME_ROLE_MIN_CONTRAST; `reachable` means exactly that, nowhere else;
 *   - the headroom is only what the search prefers: the first candidate of the walk with headroom wins; if the walk has none,
 *     the first one that passes wins (the plate stops there, it does not run on for margin that is not on offer); if it has
 *     none, the walk finds nothing.
 */
function pickByTier(walk: Iterable<Evaluated | undefined>): Evaluated | undefined {
  let firstPassing: Evaluated | undefined;
  for (const candidate of walk) {
    if (!candidate) continue;
    if (candidate.worst >= NAME_ROLE_TARGET_CONTRAST) return candidate;
    if (!firstPassing && candidate.worst >= NAME_ROLE_MIN_CONTRAST) firstPassing = candidate;
  }
  return firstPassing;
}

/** Pass 1: the name stays at what the work surface leaves it (`work.l`), the plate walks. Every candidate is recorded in `seen`. */
function* fixedNameWalk(
  candidates: readonly number[],
  work: ReadableNameLightness,
  worstAt: (nameL: number, plateL: number) => number,
  seen: Evaluated[],
): Generator<Evaluated> {
  for (const plateL of candidates) {
    const evaluated = { plateL, l: work.l, adjusted: work.adjusted, worst: worstAt(work.l, plateL) };
    seen.push(evaluated);
    yield evaluated;
  }
}

/**
 * Pass 2: the name that reads on the work surface cannot read on this plate at any lightness the plate walks to (the blends
 * inside a saturated plate's gradient dip under the criterion for it). Only then does the name move as well: at each plate
 * lightness, the nearest name lightness that reads on every surface behind it. A plate for which none reads still returns the
 * best name it has, and that candidate is recorded too: it is what the best case is drawn from when nothing passes.
 */
function* movingNameWalk(
  candidates: readonly number[],
  roleArgs: RoleArgs,
  surfacesAt: (plateL: number) => AnyBackground[],
  worstAt: (nameL: number, plateL: number) => number,
  seen: Evaluated[],
): Generator<Evaluated> {
  for (const plateL of candidates) {
    const role = readableNameLightness({ ...roleArgs, backgrounds: surfacesAt(plateL) });
    const evaluated = { plateL, l: role.l, adjusted: role.adjusted, worst: worstAt(role.l, plateL) };
    seen.push(evaluated);
    yield evaluated;
  }
}

/**
 * The order: the plate where it was saved, then the plate walking toward the work surface with the name held where the work
 * surface leaves it, then the plate walking with the name moving too, and only then "not reached" with the best that was seen.
 * Stored values and the plate's hue and chroma are never part of any of it.
 */
export function resolveNameAndPlate({ saved, plate, colours, pages, prefer }: NamePlateInput): NamePlateResult {
  const roleArgs: RoleArgs = { l: saved.l, c: saved.c, h: saved.h, prefer };
  // Everything behind the name at one plate lightness is built once however many times a walk asks for it.
  const surfaceCache = new Map<number, AnyBackground[]>();
  const surfacesAt = (plateL: number) => {
    let surfaces = surfaceCache.get(plateL);
    if (!surfaces) {
      surfaces = surfacesUnderName({ l: plateL, cmul: plate.cmul }, colours, pages);
      surfaceCache.set(plateL, surfaces);
    }
    return surfaces;
  };
  const worstFnCache = new Map<number, (l: number) => number>();
  const worstAt = (nameL: number, plateL: number) => {
    let worstFn = worstFnCache.get(plateL);
    if (!worstFn) {
      worstFn = worstContrastFor(surfacesAt(plateL), saved.c, saved.h);
      worstFnCache.set(plateL, worstFn);
    }
    return worstFn(nameL);
  };
  const reached = (e: Evaluated): NamePlateResult => ({
    l: e.l,
    adjusted: e.adjusted,
    reachable: true,
    plateL: e.plateL,
    plateShifted: e.plateL !== plate.l,
    worst: e.worst,
  });

  // A saved name that reads, or one the search moved to a value with headroom, settles it: nothing else moves.
  const room = readableNameLightness({ ...roleArgs, backgrounds: surfacesAt(plate.l) });
  const roomWorst = worstAt(room.l, plate.l);
  const asRoom = (): NamePlateResult => ({ ...room, plateL: plate.l, plateShifted: false, worst: roomWorst });
  if (room.reachable && (!room.adjusted || roomWorst >= NAME_ROLE_TARGET_CONTRAST)) return asRoom();

  // The work surface alone: the name first goes to the nearest lightness that reads on it (when the page layers leave no
  // readable name at all, the best one they have: the walks below then cannot pass, and the best case is drawn from them).
  const work = readableNameLightness({ ...roleArgs, backgrounds: pages });

  // The plate where it was saved is the first candidate of both walks: a plate that already gives the answer is not moved for
  // headroom that is not on offer (the page itself may cap the name below it).
  const candidates = [plate.l, ...plateWalk(plate, pages)];
  const seen: Evaluated[] = [];
  const picked =
    pickByTier(fixedNameWalk(candidates, work, worstAt, seen)) ??
    pickByTier(movingNameWalk(candidates, roleArgs, surfacesAt, worstAt, seen));
  if (picked) return reached(picked);

  // Nothing reads: the best of everything that was evaluated, on either walk, reported as not reached.
  const best = seen.reduce((top, e) => (e.worst > top.worst + 1e-9 ? e : top));
  return { ...reached(best), reachable: false };
}
