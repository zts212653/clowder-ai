/**
 * F163: Tag existing constitutional knowledge — shared-rules, SOP, P0 lessons.
 * AC-A5: known iron-rules and P0 LL marked as authority=constitutional.
 */

import type Database from 'better-sqlite3';

/**
 * Anchor patterns that qualify as constitutional knowledge.
 * These documents contain governance rules, iron-laws, and P0 lessons
 * that should always be available and carry the highest authority.
 */
export const CONSTITUTIONAL_PATTERNS: string[] = [
  // Governance documents
  'docs/SOP.md',
  'CLAUDE.md',
  // Lessons learned (P0 items — the file contains all LL entries)
  'docs/lessons-learned.md',
];

/**
 * Anchor LIKE patterns for broader matching (e.g., shared-rules in skills).
 * Matched with SQL LIKE.
 */
const CONSTITUTIONAL_LIKE_PATTERNS: string[] = [
  '%shared-rules%',
  '%iron-rules%',
  '%decisions/ADR-%', // ADRs are validated decisions
];

export interface TagResult {
  tagged: number;
  skipped: number;
  patterns: string[];
}

/**
 * Tag matching evidence_docs rows as constitutional + always_on.
 * Idempotent — re-running updates the same rows.
 */
export function tagConstitutional(db: Database.Database): TagResult {
  const now = new Date().toISOString();
  let tagged = 0;
  let skipped = 0;

  // Exact matches
  const updateExact = db.prepare(
    `UPDATE evidence_docs
     SET authority = 'constitutional', activation = 'always_on', verified_at = ?
     WHERE anchor = ? AND status = 'active'`,
  );

  for (const pattern of CONSTITUTIONAL_PATTERNS) {
    const result = updateExact.run(now, pattern);
    if (result.changes > 0) {
      tagged += result.changes;
    } else {
      skipped++;
    }
  }

  // LIKE matches
  const updateLike = db.prepare(
    `UPDATE evidence_docs
     SET authority = 'constitutional', activation = 'always_on', verified_at = ?
     WHERE anchor LIKE ? AND status = 'active' AND authority != 'constitutional'`,
  );

  for (const pattern of CONSTITUTIONAL_LIKE_PATTERNS) {
    const result = updateLike.run(now, pattern);
    tagged += result.changes;
  }

  return {
    tagged,
    skipped,
    patterns: [...CONSTITUTIONAL_PATTERNS, ...CONSTITUTIONAL_LIKE_PATTERNS],
  };
}
