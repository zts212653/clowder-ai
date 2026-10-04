import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '@/components/dev/oklch-tuner-engine';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { hexToOklch } from '@/lib/color-utils';
import { applyThemeCSS } from '@/stores/themeStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B probe fixture - the lineage ring (`[data-lineage-focus]`) over every layer it can sit on. The REAL theme builder
 * (`applyThemeCSS`), the real cat tokens (`CatHueInjector`, from the registry request) and the real globals.css rule. The
 * human's hue and chroma are what the co-creator injector writes in the product (`--cocreator-hue` / `--cocreator-chroma`
 * on <html>); the probe sets those two variables directly, which is the whole interface between that injector and the ring.
 *
 * `window.__ring.applyTheme` changes the theme the way the Tuner does; `window.__ring.setHuman` sets the two variables (or
 * removes them, so the static default of cat-persona-tokens.css applies).
 *
 * The REAL chain (config -> injector -> ring), as the product runs it in the new shell: the real `CoCreatorHueInjector`
 * is mounted, `window.__ring.setShell` marks <html> the way AppShell does, and `window.__ring.setConfig` publishes a
 * co-creator config through the real co-creator cache (`primeCoCreatorConfigCache`, the seam the Hub editor and the other
 * probes use), with or without a colour. `window.__ring.expected` is what the injector's own colour function gives a hex.
 */
function params(base: 'light' | 'dark', variant: 'default' | 'tuned'): TunerState {
  const next = structuredClone(base === 'light' ? INIT_LIGHT : INIT_DARK);
  if (variant === 'tuned') {
    // A Tuner-adjusted theme: richer surfaces and a surface step that moves with the user's slider.
    next.surfaceChroma = 2.2;
    next[base].surface = { L: base === 'light' ? 0.78 : 0.36, Cmul: base === 'light' ? 0.9 : 0.5 };
  }
  return next;
}

declare global {
  interface Window {
    __ring: {
      applyTheme: (base: 'light' | 'dark', variant?: 'default' | 'tuned') => void;
      setHuman: (colour: { hue: number; chroma: number } | null) => void;
      setShell: (shell: 'v2' | null) => void;
      setConfig: (color: { primary: string; secondary: string } | null) => void;
      expected: (hex: string) => { hue: string; chroma: string };
    };
  }
}

window.__ring = {
  applyTheme(base, variant = 'default') {
    document.documentElement.setAttribute('data-theme', base);
    applyThemeCSS(params(base, variant));
  },
  setHuman(colour) {
    const root = document.documentElement.style;
    if (colour) {
      root.setProperty('--cocreator-hue', String(colour.hue));
      root.setProperty('--cocreator-chroma', String(colour.chroma));
    } else {
      root.removeProperty('--cocreator-hue');
      root.removeProperty('--cocreator-chroma');
    }
  },
  setShell(shell) {
    if (shell) document.documentElement.setAttribute('data-shell', shell);
    else document.documentElement.removeAttribute('data-shell');
  },
  setConfig(color) {
    primeCoCreatorConfigCache({
      name: 'You',
      aliases: [],
      mentionPatterns: ['@co-creator'],
      ...(color ? { color } : {}),
    });
  },
  expected(hex) {
    // The same function and the same rounding the injector writes with.
    const oklch = hexToOklch(hex);
    return { hue: oklch.h.toFixed(1), chroma: oklch.c.toFixed(3) };
  },
};

const LAYERS = ['--cafe-surface-canvas', '--cafe-surface', '--cafe-surface-elevated', '--cafe-surface-sunken'];
// A cat's own bubble (the registry's cats), the human block, and a cat of any colour at the theme's plate step.
const BUBBLES = ['--color-opus-surface', '--color-codex-surface', '--color-cocreator-surface'];
// Cat colours as they come from a config: the grid, and the extremes a hex colour can have (neither on a hue step), at the
// chroma the plate step multiplies. Their (chroma, hue) are what the registry writes for #ff00ff, #00ff00, #0000ff, #ff0000,
// #ffff00 and #00ffff.
const EXTREME_CATS: Array<[number, number]> = [
  [0.322, 328.4],
  [0.295, 142.5],
  [0.313, 264.05],
  [0.258, 29.2],
  [0.211, 109.8],
  [0.155, 194.8],
];
const ANY_CAT = [
  ...[0, 60, 120, 180, 240, 300].flatMap((hue) => [0.1, 0.2].map((chroma) => [chroma, hue] as [number, number])),
  ...EXTREME_CATS,
].map(([chroma, hue]) => `oklch(var(--cat-surface-l) calc(${chroma} * var(--cat-surface-cmul)) ${hue})`);

function Strip({ background, label }: { background: string; label: string }) {
  return (
    <div data-layer={label} style={{ background, padding: 20 }}>
      <div data-lineage-focus="true" style={{ height: 24 }} />
    </div>
  );
}

function Page() {
  return (
    <div data-testid="column" style={{ width: 720 }}>
      {LAYERS.map((layer) => (
        <Strip key={layer} label={layer} background={`var(${layer})`} />
      ))}
      {BUBBLES.map((bubble) => (
        <Strip key={bubble} label={bubble} background={`var(${bubble})`} />
      ))}
      {ANY_CAT.map((background) => (
        <Strip key={background} label={background} background={background} />
      ))}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing lineage-ring fixture root');
window.__ring.applyTheme('light');
createRoot(root).render(
  <>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <Page />
  </>,
);
