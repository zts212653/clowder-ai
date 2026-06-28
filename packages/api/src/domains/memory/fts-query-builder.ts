/**
 * F200 HW-6: FTS Progressive Relaxation
 *
 * Root cause of 75% empty search results: FTS5 AND-all query semantics.
 * Long queries (14+ tokens, mixed Chinese/English) return 0 because no
 * single document contains ALL tokens.
 *
 * Fix: build a series of progressively relaxed FTS5 queries.
 * Caller tries each in order; first to return results wins.
 *
 * Levels:
 *   1. AND-all (strictest) — current behavior, works for ≤3 tokens
 *   2. Strong-AND + weak-OR — entity/anchor tokens required, rest optional
 *   3. OR-all (loosest) — BM25 naturally ranks multi-match higher
 *
 * @module fts-query-builder
 */

/** Escape a token for safe embedding in an FTS5 double-quoted phrase. */
function escapeToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Classify a token as "strong" (discriminating, should be required in relaxed queries)
 * vs "weak" (common, can be optional).
 *
 * Strong tokens: entity identifiers, longer words, CJK characters.
 */
function isStrongToken(token: string): boolean {
  // Entity identifiers: F042, ADR-005, LL-048, KD-7, AC-B1, TD-12, HW-6
  if (/^(?:F|ADR|LL|KD|TD|AC|HW)-?\d+[a-zA-Z]?$/i.test(token)) return true;
  // Phase identifiers: PhaseA, PhaseB etc.
  if (/^Phase[A-Z]$/i.test(token)) return true;
  // Any token containing CJK characters — meaningful even when short
  if (/[一-鿿㐀-䶿]/.test(token)) return true;
  // Longer tokens (≥4 chars) are more discriminating
  if (token.length >= 4) return true;
  return false;
}

/**
 * Build a progressive series of FTS5 queries from strictest to loosest.
 *
 * @returns Array of FTS5 query strings to try in order.
 *          Empty array if query is empty.
 */
export function buildProgressiveFtsQueries(query: string): string[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const escaped = tokens.map(escapeToken);

  // Short queries: AND-all works fine, no relaxation needed
  if (tokens.length <= 3) {
    return [escaped.join(' ')];
  }

  const queries: string[] = [];

  // Level 1: AND-all (strictest, current behavior)
  queries.push(escaped.join(' '));

  // Level 2: Strong tokens AND + weak tokens OR
  const strong: string[] = [];
  const weak: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isStrongToken(tokens[i])) {
      strong.push(escaped[i]);
    } else {
      weak.push(escaped[i]);
    }
  }

  if (strong.length > 0 && weak.length > 0) {
    // FTS5 requires explicit AND before parenthesized OR groups —
    // implicit AND (space) before "(...OR...)" throws syntax error.
    const strongPart = strong.join(' AND ');
    const weakPart = weak.length === 1 ? weak[0] : `(${weak.join(' OR ')})`;
    queries.push(`${strongPart} AND ${weakPart}`);
  }

  // Level 3: OR-all (loosest) — BM25 ranks multi-match higher
  queries.push(escaped.join(' OR '));

  return queries;
}
