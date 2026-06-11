'use client';

/**
 * F056 Phase E2b — Cat Persona hue/chroma injector (all-dynamic)
 *
 * Reads cat catalog primary hex → computes OKLCH hue/chroma → injects
 * :root CSS vars + generates full --color-{catId}-* derivation rules for
 * ALL cats dynamically. No static per-cat CSS rules needed.
 *
 * cat.id at runtime is the resolved catId (e.g. "opus", "codex", "sonnet"),
 * NOT the template variant id (e.g. "opus-default"). Resolution happens in
 * cat-config-loader.ts: `variant.catId ?? breed.catId`.
 *
 * Truth source (KD-25): cat-template.json (seed) + .cat-cafe/cat-catalog.json
 * (overlay), via /api/cats → useCatData hook.
 */

import { getAllConnectorDefinitions } from '@cat-cafe/shared';
import { useEffect } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToOklch } from '@/lib/color-utils';

const DYNAMIC_STYLE_ID = 'f056-dynamic-cat-tokens';
const CSS_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/* Both light and dark use the same formula, just with different fallback L/Cmul
 * values. Tuner emits :root + [data-theme="dark"] overrides for the --cat-{tier}-
 * L/Cmul vars, so the dark fallbacks below only kick in when Tuner hasn't run
 * (SSR or no localStorage state). The hue/chroma are per-cat from CatHueInjector. */
function lightDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.62) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 1)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.85) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.45)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-name-l, 0.15) var(--cat-name-c, 0.025) var(--cat-name-h, 5));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.55) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1.1)) var(--${id}-hue));` +
    `--color-${id}-primary:var(--color-${id}-bubble);` +
    `--color-${id}-light:var(--color-${id}-surface);` +
    `--color-${id}-dark:var(--color-${id}-text);` +
    `--color-${id}-bg:var(--color-${id}-surface);`
  );
}

function darkDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.68) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 0.85)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.3) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.15)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-name-l, 0.95) var(--cat-name-c, 0.1) var(--cat-name-h, 25));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.70) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1)) var(--${id}-hue));`
  );
}

export function CatHueInjector() {
  const { cats } = useCatData();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const ruleIds: string[] = [];

    for (const cat of cats) {
      if (!cat.id || !CSS_SAFE_ID.test(cat.id)) continue;
      let h = 0;
      let c = 0;
      if (cat.color?.primary) {
        try {
          const oklch = hexToOklch(cat.color.primary);
          if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
            h = oklch.h;
            c = oklch.c;
          }
        } catch {
          /* Invalid hex → neutral fallback (h=0 c=0) so tokens still exist */
        }
      }
      root.style.setProperty(`--${cat.id}-hue`, h.toFixed(1));
      root.style.setProperty(`--${cat.id}-chroma`, c.toFixed(3));
      ruleIds.push(cat.id);
    }

    /* Connector sources use the same pipeline as cats: one theme hex →
     * hexToOklch → hue/chroma → lightDecl/darkDecl derives all tiers. */
    for (const def of getAllConnectorDefinitions()) {
      if (!def.id || !CSS_SAFE_ID.test(def.id)) continue;
      if (ruleIds.includes(def.id)) continue;
      const hex = def.themeColor;
      let h = 0;
      let c = 0;
      if (hex) {
        try {
          const oklch = hexToOklch(hex);
          if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
            h = oklch.h;
            c = oklch.c;
          }
        } catch {
          /* neutral fallback */
        }
      }
      root.style.setProperty(`--${def.id}-hue`, h.toFixed(1));
      root.style.setProperty(`--${def.id}-chroma`, c.toFixed(3));
      ruleIds.push(def.id);
    }

    /* Generate dynamic token stylesheet for ALL cats + connector sources. */
    let styleEl = document.getElementById(DYNAMIC_STYLE_ID) as HTMLStyleElement | null;
    if (ruleIds.length === 0) {
      if (styleEl) styleEl.textContent = '';
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = DYNAMIC_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    const lightRules = ruleIds.map(lightDecl).join('');
    const darkRules = ruleIds.map(darkDecl).join('');
    styleEl.textContent = `:root{${lightRules}}\n[data-theme="dark"]{${darkRules}}`;
  }, [cats]);

  return null;
}
