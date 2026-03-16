// F102: SQLite schema — evidence_docs + evidence_fts + edges + markers + schema_version
// Phase C adds: embedding_meta (V2) + evidence_vectors (vec0, decoupled)

import type Database from 'better-sqlite3';

export const PRAGMA_SETUP = `
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 67108864;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS evidence_docs (
  anchor TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  source_path TEXT,
  source_hash TEXT,
  superseded_by TEXT,
  materialized_from TEXT,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title, summary,
  content=evidence_docs, content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS edges (
  from_anchor TEXT NOT NULL,
  to_anchor TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_anchor, to_anchor, relation)
);

CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT DEFAULT 'captured',
  target_kind TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

// FTS5 external-content sync triggers — must be executed one statement at a time
export const FTS_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ai AFTER INSERT ON evidence_docs BEGIN
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ad AFTER DELETE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_au AFTER UPDATE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
];

export const CURRENT_SCHEMA_VERSION = 2;

// Phase C: embedding metadata (model/dim version anchor)
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Apply all schema migrations up to CURRENT_SCHEMA_VERSION.
 * Safe to call on empty DB (creates schema_version table first).
 * Idempotent — skips already-applied versions.
 */
export function applyMigrations(db: Database.Database): void {
  // P1 fix (codex review R2): schema_version may not exist on empty DB.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1);
    for (const stmt of FTS_TRIGGER_STATEMENTS) db.exec(stmt);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  }

  if (currentVersion < 2) {
    db.exec(SCHEMA_V2);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
  }
}

/**
 * Ensure vec0 virtual table exists — called separately from migration.
 * Requires sqlite-vec extension to be loaded first.
 * Safe to call multiple times (IF NOT EXISTS).
 * Returns true if table was created/exists, false if extension unavailable.
 */
export function ensureVectorTable(db: Database.Database, dim: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vectors USING vec0(
        anchor TEXT PRIMARY KEY,
        embedding float[${dim}]
      )
    `);
    return true;
  } catch {
    return false; // sqlite-vec not loaded — fail-open
  }
}
