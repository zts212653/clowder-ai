/**
 * Context Window Size Catalog
 *
 * Static model → context window mapping shared between API and Web.
 *
 * API uses this as the last-resort fallback in Auto mode (after carrier
 * reports). Web uses it to preview draft compatibility: if a model has a
 * catalog entry, Auto mode WILL resolve — so the "needs Manual" warning
 * should not fire.
 *
 * This module is pure static data with zero runtime dependencies.
 * Runtime-only helpers (carrier report correction, known-minimum floors)
 * stay in `packages/api/src/config/context-window-sizes.ts`.
 */

export const CONTEXT_WINDOW_SIZES: Readonly<Record<string, number>> = {
  // Claude (exact values from CLI, these are fallback)
  // Issue #1208: Anthropic confirmed Opus 4.6 / Sonnet 4.6 default to 1M
  // context windows without a beta header. Update stale 200K fallbacks.
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  // Fable 5: native 1M context — the maximum is also the default (no [1m]
  // suffix needed). Also listed in KNOWN_MIN_CONTEXT_WINDOWS (API-only)
  // because stale CLIs (≤2.1.177) mis-REPORT it as 200K.
  'claude-fable-5': 1_000_000,
  // Codex/GPT
  'gpt-5.3': 128_000,
  'gpt-5.2': 128_000,
  'gpt-5.1-codex': 400_000,
  o3: 200_000,
  'o4-mini': 200_000,
  // MiniMax
  'MiniMax-M3': 1_000_000,
  // Zhipu / BigModel
  'glm-5.2': 1_000_000,
  'glm-5.2[1m]': 1_000_000,
  'minimax-m3': 1_000_000,
  // Gemini
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3.1-pro-preview': 1_000_000,
};

/**
 * Normalize provider-prefixed model IDs before lookup.
 *
 * The account routing path sets model strings like
 * `anthropic/claude-opus-4-6` or `openai-compat/gpt-5.3`.
 * Without normalization, lookups would miss the table entirely.
 */
export function stripProviderPrefix(model: string): string {
  const slashAt = model.lastIndexOf('/');
  return slashAt >= 0 ? model.slice(slashAt + 1) : model;
}

function lookupWithPrefixMatch(table: Readonly<Record<string, number>>, bare: string): number | undefined {
  if (table[bare] != null) return table[bare];
  // Prefix match (e.g. 'claude-opus-4-6-20260101' matches 'claude-opus-4-6')
  for (const [key, value] of Object.entries(table)) {
    if (bare.startsWith(key)) return value;
  }
  return undefined;
}

/**
 * Look up a model's known context window from the static catalog.
 *
 * Returns `undefined` when the model has no catalog entry — meaning
 * Auto mode cannot resolve from catalog alone and needs either a
 * carrier report or a Manual override.
 */
export function getContextWindowFallback(model: string): number | undefined {
  return lookupWithPrefixMatch(CONTEXT_WINDOW_SIZES, stripProviderPrefix(model));
}
