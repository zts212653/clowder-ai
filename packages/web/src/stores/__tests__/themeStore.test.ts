import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
}));

const LS_KEY = 'cat-cafe:themes';

describe('themeStore migrations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('discards stale built-in overrides when INIT defaults change', async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        version: '2026-05-28-per-theme-init',
        activeId: 'light',
        custom: [],
        builtInOverrides: {
          light: {
            accentHue: 50,
            accentChroma: 0.14,
            surfaceHue: 80,
            surfaceChroma: 1,
            light: {
              primary: { L: 0.62, Cmul: 1 },
              surface: { L: 0.12, Cmul: 0.12 },
              text: { L: 0.24, Cmul: 0.8 },
              inset: { L: 0.12, Cmul: 0.12 },
              ring: { L: 0.55, Cmul: 1.1 },
              insetText: { L: 0.12, C: 0.012 },
              msgText: { L: 0.12, C: 0.012 },
              elev: { sunken: 0.12, base: 0.12, elevated: 0.12, canvas: 0.12 },
            },
            dark: {
              primary: { L: 0.68, Cmul: 0.85 },
              surface: { L: 0.28, Cmul: 0.25 },
              text: { L: 0.88, Cmul: 0.6 },
              inset: { L: 0.24, Cmul: 0.1 },
              ring: { L: 0.7, Cmul: 1 },
              insetText: { L: 0.8, C: 0.02 },
              msgText: { L: 0.8, C: 0.02 },
              elev: { sunken: 0.36, base: 0.28, elevated: 0.21, canvas: 0.24 },
            },
            semanticLight: {
              criticalH: 38,
              successH: 135,
              warningH: 46,
              infoH: 209,
              L: 0.57,
              C: 0.12,
              surfL: 0.96,
              surfC: 0.03,
            },
            semanticDark: {
              criticalH: 25,
              successH: 145,
              warningH: 70,
              infoH: 230,
              L: 0.7,
              C: 0.17,
              surfL: 0.25,
              surfC: 0.05,
            },
            queue: { H: 290, C: 0.1, L: 0.62 },
            neutralHue: 30,
            neutralChroma: 0.005,
            neutralLight: {
              textL: 0.2,
              secondaryL: 0.45,
              mutedL: 0.56,
              interactiveL: 0.36,
              borderL: 0.84,
              borderSubtleL: 0.915,
              codeBgL: 0.92,
              codeTextL: 0.2,
            },
            neutralDark: {
              textL: 0.94,
              secondaryL: 0.76,
              mutedL: 0.66,
              interactiveL: 0.84,
              borderL: 0.32,
              borderSubtleL: 0.24,
              codeBgL: 0.2,
              codeTextL: 0.92,
            },
            catTextH: 5,
            catTextC: 0.025,
            catTextLightL: 0.15,
            catTextDarkL: 0.88,
          },
        },
      }),
    );

    const [{ getActiveTheme, useThemeStore }, { INIT_LIGHT }] = await Promise.all([
      import('../themeStore'),
      import('@/components/dev/oklch-tuner-engine'),
    ]);

    expect(getActiveTheme(useThemeStore.getState()).params).toEqual(INIT_LIGHT);
  });

  it('discards stale dark built-in overrides after the dark INIT defaults change', async () => {
    const { INIT_DARK } = await import('@/components/dev/oklch-tuner-engine');
    const staleDark = structuredClone(INIT_DARK);
    staleDark.accentHue = 50;
    staleDark.queue = { H: 300, C: 0.12, L: 0.5 };
    staleDark.neutralDark = {
      textL: 0.94,
      secondaryL: 0.76,
      mutedL: 0.66,
      interactiveL: 0.84,
      borderL: 0.32,
      borderSubtleL: 0.24,
      codeBgL: 0.2,
      codeTextL: 0.92,
    };

    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        version: '2026-06-10-light-token-init',
        activeId: 'dark',
        custom: [],
        builtInOverrides: {
          dark: staleDark,
        },
      }),
    );

    const { getActiveTheme, useThemeStore } = await import('../themeStore');

    expect(getActiveTheme(useThemeStore.getState()).params).toEqual(INIT_DARK);
  });
});
