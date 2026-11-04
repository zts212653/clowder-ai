import type { ActualColours } from '@/lib/readable-name-plate';
import { useThemeStore } from '@/stores/themeStore';
import { buildCSS } from '../dev/oklch-tuner-css';
import type { BackgroundPalette, Rgb } from './background-contrast';
import surfaceRegistry from './surface-roles.json';

interface SurfaceRole {
  colour: string;
  text?: string;
  persona?: boolean;
  hoverBases?: string[];
  modes?: string[];
}
const surfaceRoles: Record<string, SurfaceRole> = surfaceRegistry;

/** Read the rendered CSS roles, including theme overrides. Never duplicate a neutral lightness in JS. */
export function readBackgroundPalettes(actual?: ActualColours): Record<'light' | 'dark', BackgroundPalette[]> {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  const state = useThemeStore.getState();
  const alternate = document.createElement('style');
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;visibility:hidden';
  (document.querySelector('.console-shell') ?? document.body).append(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    probe.remove();
    throw new Error('Colour sampling unavailable');
  }
  const colours = new Map<string, Rgb>();
  const rgb = (colour: string): Rgb => {
    const cached = colours.get(colour);
    if (cached) return cached;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    const value: Rgb = [data[0], data[1], data[2]];
    colours.set(colour, value);
    return value;
  };
  const palette = (preset: (typeof state.themes)[number]): BackgroundPalette[] => {
    alternate.remove();
    // ThemeApplier uses these same parameters AND room colours. Render synchronously for every
    // candidate so a pending active-theme effect cannot leave sampling one catalogue behind.
    alternate.textContent = buildCSS(preset.params, { on: false, hue: 0, chroma: 0 }, actual);
    document.head.append(alternate);
    root.setAttribute('data-theme', preset.base);
    return Object.values(surfaceRoles)
      .filter((role) => !role.modes || role.modes.includes(preset.base))
      .flatMap((role) => {
        probe.className = role.persona ? 'cat-persona-derived' : '';
        probe.style.background = role.colour;
        probe.style.color = role.text ?? 'var(--shell-muted)';
        return (role.hoverBases ?? ['']).map((base) => {
          if (base) probe.style.setProperty('--chat-background-hover-base', base);
          else probe.style.removeProperty('--chat-background-hover-base');
          const style = getComputedStyle(probe);
          return { text: rgb(style.color), veil: rgb(style.backgroundColor) };
        });
      });
  };
  try {
    // Both reads and restoration are synchronous: no intermediate theme is painted or saved.
    const light = state.themes.filter((theme) => theme.base === 'light').flatMap(palette);
    const dark = state.themes.filter((theme) => theme.base === 'dark').flatMap(palette);
    if (!light.length || !dark.length) throw new Error('Theme palette unavailable');
    const unique = (palettes: BackgroundPalette[]) => [
      ...new Map(palettes.map((value) => [JSON.stringify(value), value])).values(),
    ];
    return { light: unique(light), dark: unique(dark) };
  } finally {
    alternate.remove();
    if (previous === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
    probe.remove();
  }
}
