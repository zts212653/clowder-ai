/**
 * Context Window Size — Runtime Helpers
 *
 * The static model → context window catalog lives in
 * `@cat-cafe/shared` (single source of truth for
 * both API Auto-mode resolution and Web draft compatibility preview).
 *
 * This module re-exports the catalog lookup and adds runtime-only
 * helpers: known-minimum floors (stale-CLI correction) and the
 * composite `resolveContextWindow` that merges carrier reports with
 * catalog + floor.
 */

// Re-export catalog lookup so existing API consumers keep their import path.
export { CONTEXT_WINDOW_SIZES, getContextWindowFallback } from '@cat-cafe/shared';

import { getContextWindowFallback, stripProviderPrefix } from '@cat-cafe/shared';

/** Local prefix-match helper for the small runtime-only floor table. */
function lookupWithPrefixMatch(table: Record<string, number>, bare: string): number | undefined {
  if (table[bare] != null) return table[bare];
  for (const [key, value] of Object.entries(table)) {
    if (bare.startsWith(key)) return value;
  }
  return undefined;
}

/**
 * Known-minimum context windows — authoritative floors used to correct
 * STALE CLI-reported window sizes, applied as `max(reported, floor)`.
 *
 * Why this exists (F24 follow-up): the Claude CLI reports
 * `modelUsage[*].contextWindow` and invoke-single-cat trusts that report
 * FIRST — so a stale CLI ships a stale window and the fallback table
 * above can never correct it. Proven in production: CLI 2.1.177 reported
 * 200_000 for `claude-fable-5` (native 1M) while the very same turn
 * consumed 303K input tokens without error; auto-seal fired at
 * "fillRatio 1.0" with 80% of the real window unused (sessions
 * 59a48070 / 6b8d4b5f, thread_mraghcf19yl6ukzu, 2026-07-08).
 *
 * Rules:
 * - `[1m]` suffix: Claude Code's own "run at 1M context" directive — if
 *   the CLI accepted the model string, 1M IS the session window.
 * - Table entries: ONLY models whose window we know from official specs
 *   with certainty. An over-estimate defeats auto-seal (the session
 *   would drift into CLI auto-compact instead of sealing with a clean
 *   handoff), so keep this list conservative.
 * - `max()` semantics: never shrinks a CLI report. Once the CLI catches
 *   up (2.1.204+ presumably reports 1M), the floor becomes a no-op.
 */
const KNOWN_MIN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
};

export function getKnownMinContextWindow(model: string): number | undefined {
  const bare = stripProviderPrefix(model);
  if (bare.endsWith('[1m]')) return 1_000_000;
  return lookupWithPrefixMatch(KNOWN_MIN_CONTEXT_WINDOWS, bare);
}

/**
 * Model/runtime discovery primitive used by the member capacity resolver:
 * CLI-reported value → versioned model catalog, then raised to a known
 * authoritative floor. Undefined stays unresolved; callers must not invent a
 * provider-wide last resort.
 */
export function resolveContextWindow(reported: number | undefined, model: string): number | undefined {
  const base = reported ?? getContextWindowFallback(model);
  const floor = getKnownMinContextWindow(model);
  if (base != null && floor != null) return Math.max(base, floor);
  return base ?? floor;
}
