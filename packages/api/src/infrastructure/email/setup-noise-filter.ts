/**
 * F140 Phase E.1 Task 2 — Setup-noise filter (context-aware, factory-based).
 *
 * Migrated from the legacy email-channel Rule 3 (deleted in E.3 cleanup):
 * strip ignorable Codex setup guidance comments. Polling side needs the same
 * suppression to prevent bot "To use Codex here, create an environment..."
 * conversation comments from getting routed as if they were real review feedback.
 *
 * Scope narrowing (砚砚 GPT-5.4 P1-1):
 *   - conversation only (inline comments belong to a review submission)
 *   - bot authors only (humans may legitimately quote the setup sentence —
 *     historical anchor: legacy classifier preserved this negative case before E.3)
 *   - setup-only: setup sentence + NO `codex review` content (a real review
 *     that happens to include the setup footer must not be suppressed)
 *
 * Trigger-template noise (裸 `@codex review` / 触发模板) is NOT handled here —
 * those are self-authored by cats/co-creator and are covered by Rule A
 * (`shouldSkipComment` self-authored skip).
 */

export interface SetupNoiseContext {
  readonly author: string;
  readonly body: string;
  readonly commentType: 'inline' | 'conversation';
}

const SETUP_GUIDANCE_SENTENCE = /to use codex here,/i;
const SETUP_GUIDANCE_ANCHOR = /environment for this repo\b/i;
const CODEX_REVIEW_CONTENT = /\bcodex review\b/i;

/**
 * Create a setup-noise filter.
 *
 * Accepts either a static array of bot logins (backward compat) or a thunk
 * that returns the current list on each call. The thunk form lets the filter
 * reflect runtime config changes (e.g. `GITHUB_SETUP_NOISE_BOT_LOGINS`
 * updated via the plugin config panel) without requiring a server restart.
 *
 * P2-3 fix: the old static-only form captured a stale `Set` at construction
 * time; plugin panel changes to bot logins were invisible until restart.
 */
export function createSetupNoiseFilter(
  botLoginsOrGetter: readonly string[] | (() => readonly string[]),
): (c: SetupNoiseContext) => boolean {
  // Static array → build Set once (fast path for tests / backward compat).
  // Thunk → rebuild Set on each call (dynamic path for runtime config changes).
  let staticBots: Set<string> | null = null;
  let getter: (() => readonly string[]) | null = null;
  if (typeof botLoginsOrGetter === 'function') {
    getter = botLoginsOrGetter;
  } else {
    staticBots = new Set(botLoginsOrGetter);
  }

  return (c: SetupNoiseContext): boolean => {
    if (!c.body) return false;
    if (c.commentType !== 'conversation') return false;

    // When staticBots is null, getter is guaranteed non-null by the if/else above.
    // Use optional chain + empty fallback for fail-closed safety (biome no-non-null).
    const bots = staticBots ?? new Set(getter?.() ?? []);
    if (!bots.has(c.author)) return false;

    const hasSetupSentence = SETUP_GUIDANCE_SENTENCE.test(c.body) && SETUP_GUIDANCE_ANCHOR.test(c.body);
    if (!hasSetupSentence) return false;

    const hasCodexReviewContent = CODEX_REVIEW_CONTENT.test(c.body);
    return !hasCodexReviewContent;
  };
}
