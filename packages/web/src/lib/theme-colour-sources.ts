/**
 * The colours the theme is drawn over, as a list: every cat in the catalogue and every connector source, each with the one
 * hex its hue and chroma come from. `CatHueInjector` writes the `--{id}-hue/-chroma` tokens from exactly this list, and the
 * name role / plate / lineage ring are resolved against exactly this list (Opus 5.5 3619: "the same list the injector
 * uses"), so what is checked is what is painted. Hue and chroma are rounded to what the injector writes into CSS.
 */
import { getAllConnectorDefinitions } from '@cat-cafe/shared';
import { hexToOklch } from '@/lib/color-utils';
import { connectorThemeToken } from '@/lib/connector-theme-token';

const CSS_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export interface ThemeColourSource {
  /** The token id (`--{id}-hue`): the resolved catId, or a connector's theme token. */
  id: string;
  hex: string | undefined;
}

/** A cat with an id the CSS can carry gets a source (with or without a colour); connectors follow, once each. */
export function themeColourSources(
  cats: ReadonlyArray<{ id?: string; color?: { primary?: string } }>,
): ThemeColourSource[] {
  const sources: ThemeColourSource[] = [];
  for (const cat of cats) {
    if (!cat.id || !CSS_SAFE_ID.test(cat.id)) continue;
    sources.push({ id: cat.id, hex: cat.color?.primary });
  }
  for (const def of getAllConnectorDefinitions()) {
    if (!def.id) continue;
    const tokenId = connectorThemeToken(def.id);
    if (!CSS_SAFE_ID.test(tokenId) || sources.some((source) => source.id === tokenId)) continue;
    sources.push({ id: tokenId, hex: def.themeColor });
  }
  return sources;
}

/** The hue and chroma a hex gives (rounded as the injector writes them), or null when it cannot be read. */
export function readHueChroma(hex: string | undefined): { h: number; c: number } | null {
  if (!hex) return null;
  try {
    const oklch = hexToOklch(hex);
    if (!Number.isFinite(oklch.h) || !Number.isFinite(oklch.c)) return null;
    return { h: Number(oklch.h.toFixed(1)), c: Number(oklch.c.toFixed(3)) };
  } catch {
    return null;
  }
}

/** What the injector falls back to for a colour that is missing or unreadable: neutral, so the tokens still exist. */
export const NEUTRAL_HUE_CHROMA = { h: 0, c: 0 } as const;
