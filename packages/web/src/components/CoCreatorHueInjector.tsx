'use client';

import { useEffect } from 'react';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { hexToOklch } from '@/lib/color-utils';
import { humanColorState } from '@/lib/human-color';

const STYLE_ID = 'f322-cocreator-roles';

/**
 * F322 B segment 1 (human message) — the human colour goes through the F056 chain, like a cat's.
 *
 * `cat-persona-tokens.css` derives the `--color-cocreator-*` roles that carry the human's colour (bubble, surface, ring,
 * primary, ...) from one hue and one chroma, with the Tuner's lightness steps on top. The name text role
 * (`--color-cocreator-text`) is not one of them: it comes from the shared cat-name role (`--cat-name-l/c/h`), so this does
 * not recolour it. Those two numbers were written once, in CSS, and never followed the config. This injector reads them from the config that has arrived (the way `CatHueInjector` does for the cats), so the
 * roles, the Tuner, the saved themes and light / dark all keep working, and the colour changes with the config.
 *
 * Scope: only the new presentation (`html[data-shell="v2"]`). The classic UI keeps the look it has always had, and an
 * unconfigured or unreadable colour writes nothing, so the baked defaults apply instead of an invented colour.
 */
export function CoCreatorHueInjector() {
  const state = humanColorState(useCoCreatorConfig());
  const primary = state.status === 'configured' ? state.color.primary : null;

  useEffect(() => {
    const existing = document.getElementById(STYLE_ID);
    if (!primary) {
      existing?.remove();
      return;
    }
    let hue = 0;
    let chroma = 0;
    try {
      const oklch = hexToOklch(primary);
      if (!Number.isFinite(oklch.h) || !Number.isFinite(oklch.c)) throw new Error('unreadable colour');
      hue = oklch.h;
      chroma = oklch.c;
    } catch {
      existing?.remove();
      return;
    }
    const el = existing ?? document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `html[data-shell="v2"]{--cocreator-hue:${hue.toFixed(1)};--cocreator-chroma:${chroma.toFixed(3)};}`;
    if (!existing) document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [primary]);

  return null;
}
