import { type ActualPlateColour, platesOf } from '../readable-name-plate';
import { nameContrast } from '../readable-name-role';

/** Shared by the resolver's test files (F322 B follow-up; Opus 5.5 3327 + 3619, codex-sol and cloud review of #5086). */
export const NAME = { c: 0.025, h: 5 };

/** Light theme: pages (as the name is drawn over them) and a plate step. */
export const lightPages = [
  { l: 0.92, c: 0.015, h: 80, nameAlpha: 0.8 },
  { l: 0.95, c: 0.012, h: 80, nameAlpha: 0.8 },
  { l: 0.99, c: 0.006, h: 80, nameAlpha: 0.8 },
  { l: 0.995, c: 0.004, h: 80, nameAlpha: 0.8 },
];
export const darkPages = [
  { l: 0.275, c: 0.015, h: 80, nameAlpha: 0.8 },
  { l: 0.18, c: 0.012, h: 80, nameAlpha: 0.8 },
  { l: 0.1, c: 0.006, h: 80, nameAlpha: 0.8 },
  { l: 0.18, c: 0.004, h: 80, nameAlpha: 0.8 },
];

/** Cats whose colours sit far apart in luminance at one lightness: a saturated blue and a saturated yellow. */
export const spreadColours: ActualPlateColour[] = [
  { h: 264, c: 0.3 },
  { h: 100, c: 0.2 },
];
/** Ordinary catalogue colours. */
export const regularColours: ActualPlateColour[] = [
  { h: 250, c: 0.12 },
  { h: 25, c: 0.15 },
  { h: 145, c: 0.1 },
];

export const everythingFor = (plateL: number, cmul: number, colours: ActualPlateColour[], pages: typeof lightPages) => [
  ...platesOf({ l: plateL, cmul }, colours),
  ...pages,
];
export const worstOver = (l: number, backgrounds: ReturnType<typeof everythingFor>) =>
  Math.min(...backgrounds.map((bg) => nameContrast({ l, ...NAME }, bg)));

/** Every combination of the given lists, so a property sweep is one flat loop instead of a nest of them. */
export function cartesian<T extends unknown[][]>(...lists: T): Array<{ [K in keyof T]: T[K][number] }> {
  return lists.reduce<unknown[][]>(
    (acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])),
    [[]],
  ) as Array<{
    [K in keyof T]: T[K][number];
  }>;
}

/** The six edge colours a hex can have (the ring probe's own list): the most saturated plates a config can bring. */
export const extremeColours: ActualPlateColour[] = [
  { h: 328, c: 0.322 },
  { h: 142, c: 0.295 },
  { h: 264, c: 0.313 },
  { h: 29, c: 0.258 },
  { h: 110, c: 0.211 },
  { h: 195, c: 0.155 },
];

/** Page layers in the middle of the lightness scale: no name lightness reads on them, whatever the plate does. */
export const midPages = [0.4, 0.45, 0.5, 0.45].map((l) => ({ l, c: 0.01, h: 80, nameAlpha: 0.8 }));

/** The lightnesses from `from` toward `to`, `step` apart, `from` first and `to` last (a signed walk, either direction). */
export function platesToward(from: number, to: number, step = 0.01): number[] {
  const sign = to >= from ? 1 : -1;
  const plates = [from];
  for (let k = 1; sign * (to - (from + sign * k * step)) > 1e-9; k++) plates.push(from + sign * k * step);
  plates.push(to);
  return plates;
}
