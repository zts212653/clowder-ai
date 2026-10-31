import { afterEach, expect, it, vi } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import * as renderer from '../../dev/oklch-tuner-css';
import { INIT_LIGHT } from '../../dev/oklch-tuner-engine';
import { resolveTunerNameAndPlate } from '../../dev/oklch-tuner-name-role';
import { readBackgroundPalettes } from '../background-palette';

it('resolves inactive custom presets with the same actual room colours as ThemeApplier', () => {
  const actual = {
    cats: [
      { h: 250, c: 0.12 },
      { h: 25, c: 0.15 },
      { h: 145, c: 0.1 },
      { h: 300, c: 0.14 },
      { h: 60, c: 0.13 },
    ],
    human: { h: 58, c: 0.04 },
  };
  const state = useThemeStore.getState();
  const params = structuredClone(INIT_LIGHT);
  params.light.surface = { L: 0.4, Cmul: 0.99 };
  useThemeStore.setState({
    activeId: 'light',
    themes: [...state.themes, { ...state.themes[0], id: 'custom-actual', builtIn: false, params }],
  });
  const build = vi.spyOn(renderer, 'buildCSS');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    color: 'rgb(0,0,0)',
    backgroundColor: 'rgb(255,255,255)',
  } as CSSStyleDeclaration);
  try {
    expect(resolveTunerNameAndPlate(params, false).plateL).toBe(0.61);
    expect(resolveTunerNameAndPlate(params, false, actual).plateL).toBe(0.6);
    readBackgroundPalettes(actual);
    expect(build).toHaveBeenCalledWith(params, { on: false, hue: 0, chroma: 0 }, actual);
  } finally {
    useThemeStore.setState({ activeId: state.activeId, themes: state.themes });
  }
});

it('includes each image-bearing surface and excludes opaque emphasis controls', () => {
  let fill = '';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(value: string) {
      fill = value;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([...(fill.match(/\d+/g) ?? []).map(Number), 255]) }),
  } as unknown as CanvasRenderingContext2D);
  const colours: Record<string, string> = {
    'var(--shell-work)': 'rgb(250, 249, 248)',
    'var(--shell-frame)': 'rgb(235, 234, 233)',
    'var(--shell-paper)': 'rgb(255, 254, 253)',
    'var(--shell-selected)': 'rgb(220, 219, 218)',
    'var(--shell-group)': 'rgb(242, 241, 240)',
    'var(--color-cocreator-surface)': 'rgb(230, 210, 190)',
    'var(--shell-primary)': 'rgb(120, 60, 40)',
    'var(--shell-ink)': 'rgb(40, 39, 38)',
  };
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = (element as HTMLElement).style;
    return {
      backgroundColor: colours[style.background],
      color:
        style.color === 'var(--shell-primary-on)' || style.color === 'var(--shell-paper)'
          ? 'rgb(255, 254, 253)'
          : 'rgb(80, 79, 78)',
    } as CSSStyleDeclaration;
  });
  const result = readBackgroundPalettes();
  for (const mode of ['light', 'dark'] as const) {
    expect(result[mode].map((palette) => palette.veil)).toEqual(
      expect.arrayContaining(
        Object.entries(colours)
          .filter(([role]) => !['var(--shell-primary)', 'var(--shell-ink)'].includes(role))
          .map(([, colour]) => (colour.match(/\d+/g) ?? []).map(Number)),
      ),
    );
    expect(result[mode]).not.toContainEqual({ veil: [120, 60, 40], text: [255, 254, 253] });
    expect(result[mode].some((palette) => palette.veil[0] === 40)).toBe(false);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

it('samples configured custom counterparts as well as the built-in presets', () => {
  const before = useThemeStore.getState();
  const custom = {
    ...before.themes.find((theme) => theme.id === 'dark')!,
    id: 'custom-dark',
    builtIn: false,
    params: structuredClone(before.themes[1].params),
  };
  custom.params.dark.elev.canvas = 0.34;
  useThemeStore.setState({ activeId: 'light', themes: [...before.themes, custom] });
  vi.spyOn(renderer, 'buildCSS').mockImplementation(
    (params) => `:root { --fixture-canvas: ${params.dark.elev.canvas} }`,
  );
  let fill = '';
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(value: string) {
      fill = value;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([...(fill.match(/\d+/g) ?? []).map(Number), 255]) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        color: 'rgb(177, 173, 172)',
        backgroundColor: document.head.lastElementChild?.textContent?.includes('0.34')
          ? 'rgb(55, 55, 55)'
          : 'rgb(31, 31, 31)',
      }) as CSSStyleDeclaration,
  );
  try {
    const result = readBackgroundPalettes();
    expect(result.dark).toContainEqual({ text: [177, 173, 172], veil: [55, 55, 55] });
    expect(useThemeStore.getState().activeId).toBe('light');
  } finally {
    useThemeStore.setState({ activeId: before.activeId, themes: before.themes });
  }
});

it('samples the computed shell-muted and shell-work roles for both modes and restores the visible theme', () => {
  const colours = {
    light: { color: 'rgb(88, 84, 84)', backgroundColor: 'rgb(254, 251, 248)' },
    dark: { color: 'rgb(177, 173, 172)', backgroundColor: 'rgb(31, 31, 31)' },
  };
  let fill = '';
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(value: string) {
      fill = value;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([...(fill.match(/\d+/g) ?? []).map(Number), 255]) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    expect((element as HTMLElement).style.color).toMatch(/^var\(--/);
    expect((element as HTMLElement).style.background).toMatch(/^var\(--/);
    return colours[document.documentElement.dataset.theme as 'light' | 'dark'] as unknown as CSSStyleDeclaration;
  });
  document.documentElement.dataset.theme = 'dark';
  const palettes = readBackgroundPalettes();
  expect(palettes.light).toContainEqual({ text: [88, 84, 84], veil: [254, 251, 248] });
  expect(palettes.dark).toContainEqual({ text: [177, 173, 172], veil: [31, 31, 31] });
  expect(document.documentElement.dataset.theme).toBe('dark');
  colours.light.color = 'rgb(70, 68, 65)';
  expect(readBackgroundPalettes().light[0].text).toEqual([70, 68, 65]);
  expect(document.querySelector('span[style*="visibility"]')).toBeNull();
});
