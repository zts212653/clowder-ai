import { describe, expect, it } from 'vitest';
import {
  CLASSIC_NAME_OPACITY,
  NAME_ROLE_MIN_CONTRAST,
  NAME_ROLE_TARGET_CONTRAST,
  nameContrast,
} from '@/lib/readable-name-role';
import { buildCSS } from '../oklch-tuner-css';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '../oklch-tuner-engine';
import { drawnNameLightness, nameBackgrounds } from '../oklch-tuner-name-role';

/**
 * F322 B — the Tuner theme the user saved must come out readable without being rewritten. Independent Alpha acceptance of
 * #4978 (2026-10-01) saved: Light plate surface L .78 / Cmul .99 and the cat-name role at H 144 / L .78 / C .025.
 */
const NO_HC = { on: false, hue: 0, chroma: 0 };
const nameVar = (css: string, scope: ':root' | '[data-theme="dark"]', name: string) => {
  const block = css.split('}').find((rule) => rule.trimStart().startsWith(`${scope}{--cat-bubble-l`));
  const match = block?.match(new RegExp(`--cat-name-${name}:([^;}]+)`));
  if (!match) throw new Error(`no ${scope} --cat-name-${name} in the generated CSS`);
  return match[1];
};

function alphaRepro(): TunerState {
  const p = structuredClone(INIT_LIGHT);
  p.light.surface = { L: 0.78, Cmul: 0.99 };
  p.catTextLightL = 0.78;
  p.catTextH = 144;
  p.catTextC = 0.025;
  return p;
}

describe('the drawn lightness of the cat-name role', () => {
  it('is exactly the saved lightness in every built-in theme, in both modes: nothing existing moves', () => {
    for (const base of [INIT_LIGHT, INIT_DARK]) {
      expect(drawnNameLightness(base, false)).toBe(base.catTextLightL);
      expect(drawnNameLightness(base, true)).toBe(base.catTextDarkL);
    }
  });

  it('is exactly the saved lightness in the tuned surfaces the nameplate evidence was measured on', () => {
    for (const [base, dark] of [
      [INIT_LIGHT, false],
      [INIT_DARK, true],
    ] as const) {
      const tuned = structuredClone(base);
      tuned.surfaceChroma = 2.2;
      (dark ? tuned.dark : tuned.light).surface = { L: dark ? 0.36 : 0.78, Cmul: dark ? 0.5 : 0.9 };
      expect(drawnNameLightness(tuned, dark)).toBe(dark ? tuned.catTextDarkL : tuned.catTextLightL);
    }
  });

  it('moves the Alpha repro off the plate lightness, and the drawn name reads against every background of the theme', () => {
    const p = alphaRepro();
    const drawn = drawnNameLightness(p, false);

    expect(drawn).toBeLessThan(0.78);
    for (const bg of nameBackgrounds(p, false)) {
      expect(nameContrast({ l: drawn, c: p.catTextC, h: p.catTextH }, bg)).toBeGreaterThanOrEqual(
        NAME_ROLE_MIN_CONTRAST,
      );
    }
  });

  it('checks the page layers as the classic header draws the name over them: at its own opacity', () => {
    const layers = nameBackgrounds(alphaRepro(), false).filter((bg) => bg.nameAlpha !== undefined);

    expect(layers).toHaveLength(4);
    expect(layers.every((bg) => bg.nameAlpha === CLASSIC_NAME_OPACITY)).toBe(true);
  });

  it('keeps a dark theme with the name at the plate lightness readable at the classic opacity too', () => {
    const p = structuredClone(INIT_DARK);
    p.dark.surface = { L: 0.3, Cmul: 0.99 };
    p.catTextDarkL = 0.3;
    const drawn = drawnNameLightness(p, true);

    expect(drawn).toBeGreaterThan(0.3);
    for (const bg of nameBackgrounds(p, true)) {
      expect(nameContrast({ l: drawn, c: p.catTextC, h: p.catTextH }, bg)).toBeGreaterThanOrEqual(
        NAME_ROLE_MIN_CONTRAST,
      );
    }
  });

  it('keeps a saved name that already reads at the criterion, even when it is under the headroom the search aims for', () => {
    // Sol6.1's counterexample (#4985 review): plate step L .85 / Cmul 0, name H 0 / C 0 / L .39. Against every background of
    // the theme (page layers at the classic header's opacity included) it measures 4.615 - over 4.5, under 4.65.
    const p = structuredClone(INIT_LIGHT);
    p.light.surface = { L: 0.85, Cmul: 0 };
    p.catTextLightL = 0.39;
    p.catTextC = 0;
    p.catTextH = 0;

    const worst = Math.min(...nameBackgrounds(p, false).map((bg) => nameContrast({ l: 0.39, c: 0, h: 0 }, bg)));
    expect(worst).toBeGreaterThanOrEqual(NAME_ROLE_MIN_CONTRAST);
    expect(worst).toBeLessThan(NAME_ROLE_TARGET_CONTRAST);
    // It already reads, so what is drawn is what was saved.
    expect(drawnNameLightness(p, false)).toBe(0.39);
    expect(Number(nameVar(buildCSS(p, NO_HC), ':root', 'l'))).toBe(0.39);
  });

  it('puts the drawn lightness in the generated CSS and leaves the user hue, chroma and plate as they are', () => {
    const p = alphaRepro();
    const css = buildCSS(p, NO_HC);

    expect(Number(nameVar(css, ':root', 'l'))).toBe(drawnNameLightness(p, false));
    expect(Number(nameVar(css, ':root', 'l'))).toBeLessThan(0.78);
    expect(nameVar(css, ':root', 'h')).toBe('144');
    expect(nameVar(css, ':root', 'c')).toBe('0.025');
    expect(css).toContain('--cat-surface-l:0.78;--cat-surface-cmul:0.99;');
  });

  it('never rewrites what the user saved: the params that go in come out unchanged', () => {
    const p = alphaRepro();
    const before = structuredClone(p);

    buildCSS(p, NO_HC);
    drawnNameLightness(p, false);
    drawnNameLightness(p, true);

    expect(p).toEqual(before);
  });

  it('is decided per mode: a Light problem does not touch Dark, and Dark is judged against Dark backgrounds', () => {
    const p = alphaRepro();
    const css = buildCSS(p, NO_HC);

    expect(Number(nameVar(css, '[data-theme="dark"]', 'l'))).toBe(p.catTextDarkL);

    const darkProblem = structuredClone(INIT_DARK);
    darkProblem.dark.surface = { L: 0.3, Cmul: 0.99 };
    darkProblem.catTextDarkL = 0.3;
    expect(drawnNameLightness(darkProblem, true)).toBeGreaterThan(0.3);
    expect(drawnNameLightness(darkProblem, false)).toBe(darkProblem.catTextLightL);
  });

  it('leaves a blocked theme at its best lightness instead of throwing, and keeps the output a number', () => {
    const blocked = structuredClone(INIT_DARK);
    blocked.dark.surface = { L: 0.6, Cmul: 0.99 };

    const drawn = drawnNameLightness(blocked, true);
    expect(Number.isFinite(drawn)).toBe(true);
    expect(drawn).toBeGreaterThanOrEqual(0);
    expect(drawn).toBeLessThanOrEqual(1);
    expect(() => buildCSS(blocked, NO_HC)).not.toThrow();
  });
});
