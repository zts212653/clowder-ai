import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '@/components/dev/oklch-tuner-engine';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { hexToOklch } from '@/lib/color-utils';
import { useThemeStore } from '@/stores/themeStore';
import { ActualProbe, themeApplied } from './f322-theme-applied';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B probe fixture - the lineage ring (`[data-lineage-focus]`) over every layer it can sit on, through the REAL theme
 * pipeline: the theme store -> `ThemeApplier` -> `applyThemeCSS`, resolved against the cats the registry request returns and the
 * human colour the real co-creator injector paints (`CoCreatorHueInjector`, in the new shell, from a config published through
 * the real co-creator cache). Real cat tokens (`CatHueInjector`) and the real globals.css rule.
 *
 * `window.__ring.applyTheme` changes the theme the way the Tuner does (the store's own actions, so the real applier applies
 * it); `setConfig` publishes a co-creator config (or one without a colour); `applied()` resolves when the page shows the
 * active theme resolved against the room as it is now; `expected` is what the injector's own colour function gives a hex.
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
      setConfig: (color: { primary: string; secondary: string } | null) => void;
      applied: () => Promise<void>;
      expected: (hex: string) => { hue: string; chroma: string };
    };
  }
}

window.__ring = {
  applyTheme(base, variant = 'default') {
    const store = useThemeStore.getState();
    if (variant !== 'tuned') {
      store.setActive(base);
      return;
    }
    if (!store.createCustom('Tuned', base)) throw new Error('could not create the tuned theme');
    useThemeStore.getState().updateParams(params(base, variant));
  },
  setConfig(color) {
    primeCoCreatorConfigCache({
      name: 'You',
      aliases: [],
      mentionPatterns: ['@co-creator'],
      ...(color ? { color } : {}),
    });
  },
  applied: themeApplied,
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

/**
 * `claimed` strips are what the ring is promised to read on: the page layers and the surfaces of the cats and the human that
 * really exist. `unclaimed` ones are cats of any colour nobody has (the old swept range): measured and disclosed, not promised.
 */
function Strip({ background, label, claimed = true }: { background: string; label: string; claimed?: boolean }) {
  return (
    <div {...(claimed ? { 'data-layer': label } : { 'data-unclaimed': label })} style={{ background, padding: 20 }}>
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
        <Strip key={background} label={background} background={background} claimed={false} />
      ))}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing lineage-ring fixture root');
// What AppShell does: only the new presentation marks <html> (the ring's human colour is the new shell's).
if (window.localStorage.getItem('cat-cafe:shell-presentation') === 'v2') {
  document.documentElement.setAttribute('data-shell', 'v2');
}
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <ActualProbe />
    <Page />
  </ThemeProvider>,
);
