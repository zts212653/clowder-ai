/**
 * Resolve a registered catId to its primary stable mention handle, and
 * normalise `@catId` tokens inside free-form text to `@<handle>`.
 *
 * Why this exists (F128):
 *   AgentRouter.parseAllMentions only recognises mentions that match
 *   catRegistry's configured `mentionPatterns` (e.g. "@砚砚", "@opus46").
 *   Raw catId tokens like `@cat-rcs85pvn` are NOT in those patterns, so
 *   downstream dispatch can't route on them. When a cat proposes a new
 *   thread it sometimes writes `@cat-rcs85pvn` into `initialMessage`
 *   (carried over from `cat_cafe_get_thread_cats` output). Normalising at
 *   the propose boundary lets the persisted message route correctly.
 *
 *   Keeps `preferredCats` field on the proposal record AS-IS (catIds are
 *   the right shape for dispatch lookup). Only the human-readable
 *   `initialMessage` text is rewritten so router can identify the mention.
 */

import { catRegistry } from '@cat-cafe/shared';

/**
 * Resolve a registered catId to its primary stable mention handle (with
 * leading "@"). Returns null if the catId is not registered or the entry has
 * no mention patterns configured.
 *
 * Example: `cat-rcs85pvn` → `"@砚砚"`
 */
export function primaryMentionHandleForCatId(catId: string): string | null {
  const entry = catRegistry.tryGet(catId);
  if (!entry) return null;
  const pattern = entry.config.mentionPatterns?.[0];
  if (!pattern) return null;
  return pattern.startsWith('@') ? pattern : `@${pattern}`;
}

/**
 * Replace `@<token>` matches in text with the cat's primary mention handle
 * when the token resolves to a registered catId. Tokens that don't resolve
 * (e.g. user wrote `@co-creator` or already-stable handles like `@砚砚`) are left
 * untouched.
 *
 * Test seam: callers may pass a custom `resolveHandle` to test without
 * touching the global catRegistry state.
 */
export function normalizeCatIdMentionsInText(
  text: string,
  resolveHandle: (token: string) => string | null = primaryMentionHandleForCatId,
): string {
  // Match @<token> where token starts with a letter and may contain letters,
  // digits, underscore, or hyphen. Hyphen support is what makes `@cat-rcs85pvn`
  // captured as a single token instead of stopping at `@cat`.
  return text.replace(/@([A-Za-z][A-Za-z0-9_-]*)/g, (full, captured: string) => {
    const handle = resolveHandle(captured);
    return handle ?? full;
  });
}
