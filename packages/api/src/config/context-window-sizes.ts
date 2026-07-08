/**
 * Context Window Size Fallback Table
 * F24: Hardcoded model → context window mapping for cats whose CLI
 * doesn't report window size (Codex exec, Gemini -p).
 *
 * Claude CLI reports exact values via modelUsage[model].contextWindow,
 * so these entries are fallback only.
 * Update when new models are released or window sizes change.
 */

export const CONTEXT_WINDOW_SIZES: Record<string, number> = {
  // Claude (exact values from CLI, these are fallback)
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  // Fable 5: native 1M context — the maximum is also the default (no [1m]
  // suffix needed). Also listed in KNOWN_MIN_CONTEXT_WINDOWS below because
  // stale CLIs (≤2.1.177) mis-REPORT it as 200K, which this table alone
  // cannot fix (CLI report outranks the fallback table).
  'claude-fable-5': 1_000_000,
  // Codex/GPT
  'gpt-5.3': 128_000,
  'gpt-5.2': 128_000,
  'gpt-5.1-codex': 400_000,
  o3: 200_000,
  'o4-mini': 200_000,
  // MiniMax
  'MiniMax-M3': 1_000_000,
  'minimax-m3': 1_000_000,
  // Gemini
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3.1-pro-preview': 1_000_000,
};

/**
 * clowder#915 R5 cloud P2: when opencode runs against a model NOT in the
 * fallback table (GLM-5.1, openrouter custom names, etc.), the F24
 * context_health block silently skips and handoff never fires. This is
 * a last-resort default used ONLY when both `usage.contextWindowSize`
 * AND `getContextWindowFallback(model)` return undefined.
 *
 * 128_000 was chosen as a middle-ground: covers GLM-5.1 (128k), most
 * GPT 128k variants, and stays safely under Claude (200k) so the
 * 0.85 seal threshold trips around 108k — safely before any real
 * provider's hard limit.
 *
 * Critical: this is a LAST-RESORT — known models (claude-opus-4-6,
 * gpt-5.x, etc.) MUST resolve through the fallback table first so we
 * use their precise window. Putting this unconditionally on the
 * transformer would defeat the table for opencode's default
 * claude-opus-4-6 (200k → wrongly capped at 128k).
 */
export const OPENCODE_DEFAULT_CONTEXT_WINDOW = 128_000;

// Normalize provider-prefixed model IDs before lookup. The account routing
// path in invoke-single-cat sets `callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE`
// to a `safeProvider/model` form (see L1459 `safeProvider/safeModel`), and
// OpenCodeAgentService propagates that prefixed string as `metadata.model`.
// Without normalization, lookups like `anthropic/claude-opus-4-6` or
// `openai-compat/gpt-5.3` would miss the table entirely → no windowSize →
// F24 context_health silently skipped → opencode handoff (clowder#915)
// bypassed in production. (clowder#915 R2 cloud P1)
//
// Use lastIndexOf to handle multi-segment prefixes like `openai-compat/x/y`
// (defensive — current code emits at most one slash, but the cost is the
// same and we don't want to be the next migration's footgun).
function stripProviderPrefix(model: string): string {
  const slashAt = model.lastIndexOf('/');
  return slashAt >= 0 ? model.slice(slashAt + 1) : model;
}

function lookupWithPrefixMatch(table: Record<string, number>, bare: string): number | undefined {
  if (table[bare]) return table[bare];
  // Prefix match (e.g. 'claude-opus-4-6-20260101' matches 'claude-opus-4-6')
  for (const [key, value] of Object.entries(table)) {
    if (bare.startsWith(key)) return value;
  }
  return undefined;
}

export function getContextWindowFallback(model: string): number | undefined {
  return lookupWithPrefixMatch(CONTEXT_WINDOW_SIZES, stripProviderPrefix(model));
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
 * Single resolution point for "how big is this session's context window":
 * CLI-reported value → fallback table, then raised to any known
 * authoritative floor. Callers needing a provider-specific last resort
 * (e.g. opencode's 128K default) apply it AFTER this returns undefined.
 */
export function resolveContextWindow(reported: number | undefined, model: string): number | undefined {
  const base = reported ?? getContextWindowFallback(model);
  const floor = getKnownMinContextWindow(model);
  if (base != null && floor != null) return Math.max(base, floor);
  return base ?? floor;
}
