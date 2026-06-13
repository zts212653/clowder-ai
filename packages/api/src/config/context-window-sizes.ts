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
  // Codex/GPT
  'gpt-5.3': 128_000,
  'gpt-5.2': 128_000,
  'gpt-5.1-codex': 400_000,
  o3: 200_000,
  'o4-mini': 200_000,
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

export function getContextWindowFallback(model: string): number | undefined {
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
  const slashAt = model.lastIndexOf('/');
  const bare = slashAt >= 0 ? model.slice(slashAt + 1) : model;
  if (CONTEXT_WINDOW_SIZES[bare]) return CONTEXT_WINDOW_SIZES[bare];
  // Try prefix match (e.g. 'claude-opus-4-6-20260101' matches 'claude-opus-4-6')
  for (const [key, value] of Object.entries(CONTEXT_WINDOW_SIZES)) {
    if (bare.startsWith(key)) return value;
  }
  return undefined;
}
