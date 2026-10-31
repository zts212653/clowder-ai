/**
 * F260 Phase A — doc_aliases mirror job.
 *
 * Mirrors evidence_docs titles (and feature F-numbers) into the `doc_aliases` table.
 * Uses delete-rebuild pattern (same as EntityRegistry.refreshMentions) for idempotency.
 *
 * Design constraints (KD-5, INV-2):
 * - Writes ONLY to doc_aliases, NEVER to entity_registry
 * - doc_aliases is physically separate from entity_registry (策展 vs 机械)
 * - Filters out stop-word patterns and short titles to prevent noise
 */

import type Database from 'better-sqlite3';
import { normalizeEntityAlias } from './EntityRegistry.js';

// Stop-word patterns for titles that should NOT become aliases (plan T2).
// These are too generic to be useful as entity references.
const STOP_TITLE_PATTERNS =
  /^(readme|index|phase\s+[a-z0-9]+|todo|misc|changelog|license|contributing|appendix|overview|summary|introduction|conclusion|references|acknowledgments|glossary|contents)$/i;

// Generic single-word English titles too ambiguous to be useful aliases (AC-A1: `test` → 6 threads).
// Lowercase comparison. Only blocks exact single-word matches — "test plan" or "debug session" pass.
const GENERIC_WORD_STOP_SET = new Set([
  'test',
  'debug',
  'draft',
  'temp',
  'demo',
  'notes',
  'untitled',
  'backup',
  'copy',
  'help',
  'docs',
  'info',
  'sample',
  'example',
  'hello',
  'data',
  'main',
  'setup',
  'config',
  'build',
  'output',
  'log',
  'logs',
  'fix',
  'bug',
  'wip',
  'task',
  'review',
  'edit',
]);

// Auto-generated operational title patterns (session digests, MR rotation, gate reports, triage).
const AUTO_GENERATED_PATTERNS =
  /^(session\s+\d+\s*[—–-]|mr\s+review\s*\(auto-rotated\s+from|public\s+delta\s+gate\s+report|review\s+triage\b)/i;

// Minimum title length to become an alias (avoids single-word noise like "API", "FAQ")
const MIN_TITLE_LENGTH = 4;

// Feature ID pattern (e.g. "F260", "F083")
const FEATURE_ID_PATTERN = /^F\d+$/;

interface DocRow {
  anchor: string;
  title: string;
  kind: string;
  provenance_tier: string | null;
}

interface AliasInsert {
  alias_norm: string;
  alias: string;
  doc_anchor: string;
  source: string;
  authority_tier: string;
}

/**
 * Check if a title should be filtered out as a stop-word or too short/generic.
 *
 * Filter layers (AC-A1 precision gate):
 *  1. Too short (< MIN_TITLE_LENGTH chars)
 *  2. Structural doc titles (readme, index, todo, ...)
 *  3. Generic single-word English terms (test, debug, draft, ...)
 *  4. Auto-generated operational titles (session digests, MR rotation)
 */
function isStopTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length < MIN_TITLE_LENGTH) return true;
  if (STOP_TITLE_PATTERNS.test(trimmed)) return true;
  if (GENERIC_WORD_STOP_SET.has(trimmed.toLowerCase())) return true;
  if (AUTO_GENERATED_PATTERNS.test(trimmed)) return true;
  return false;
}

/**
 * Mirror evidence_docs titles into doc_aliases.
 *
 * Delete-rebuild pattern: clears all mirror-sourced aliases, then re-inserts
 * from current evidence_docs. This guarantees INV-8 (deleted docs lose aliases).
 *
 * @param db - better-sqlite3 Database instance (same DB as evidence store)
 */
export function mirrorDocAliases(db: Database.Database): void {
  const MIRROR_SOURCES = ['doc-title', 'feature-id', 'frontmatter-alias'];

  db.transaction(() => {
    // Phase 1: Delete all mirror-sourced aliases (delete-rebuild)
    const placeholders = MIRROR_SOURCES.map(() => '?').join(', ');
    db.prepare(`DELETE FROM doc_aliases WHERE source IN (${placeholders})`).run(...MIRROR_SOURCES);

    // Phase 2: Read all evidence_docs
    const docs = db
      .prepare(
        `SELECT anchor, title, kind, provenance_tier
         FROM evidence_docs
         WHERE status = 'active'`,
      )
      .all() as DocRow[];

    const now = new Date().toISOString();
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO doc_aliases
       (alias_norm, alias, doc_anchor, source, authority_tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const aliases: AliasInsert[] = [];

    for (const doc of docs) {
      const tier = doc.provenance_tier ?? 'unknown';

      // Mirror title as doc-title alias (if not a stop-word)
      if (!isStopTitle(doc.title)) {
        aliases.push({
          alias_norm: normalizeEntityAlias(doc.title),
          alias: doc.title,
          doc_anchor: doc.anchor,
          source: 'doc-title',
          authority_tier: tier,
        });
      }

      // Feature docs: also mirror the F-number as feature-id alias
      if (doc.kind === 'feature' && FEATURE_ID_PATTERN.test(doc.anchor)) {
        aliases.push({
          alias_norm: normalizeEntityAlias(doc.anchor),
          alias: doc.anchor,
          doc_anchor: doc.anchor,
          source: 'feature-id',
          authority_tier: tier,
        });
      }
    }

    // Phase 3: Insert all aliases
    for (const a of aliases) {
      insertStmt.run(a.alias_norm, a.alias, a.doc_anchor, a.source, a.authority_tier, now);
    }
  })();
}
