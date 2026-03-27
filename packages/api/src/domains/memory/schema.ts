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

export const CURRENT_SCHEMA_VERSION = 7;

// Phase C: embedding metadata (model/dim version anchor)
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Phase E: evidence_passages table (per-message granularity)
export const SCHEMA_V3_TABLE = `
CREATE TABLE IF NOT EXISTS evidence_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_anchor TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  content TEXT NOT NULL,
  speaker TEXT,
  position INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(doc_anchor, passage_id)
);
`;

// Phase E: passage_fts virtual table — executed separately (tokenchars needs careful quoting)
export const SCHEMA_V3_FTS =
  'CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(content, content=evidence_passages, content_rowid=rowid, tokenize="unicode61 tokenchars \'_-\'")';

// FTS5 external-content sync triggers for passage_fts — executed one statement at a time
export const PASSAGE_FTS_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ai AFTER INSERT ON evidence_passages BEGIN
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ad AFTER DELETE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_au AFTER UPDATE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
];

// Phase G: summary_segments (append-only ledger) + summary_state (watermark)
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS summary_segments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  from_message_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  topic_label TEXT NOT NULL,
  boundary_reason TEXT,
  boundary_confidence TEXT DEFAULT 'medium',
  related_segment_ids TEXT,
  candidates TEXT,
  supersedes_segment_ids TEXT,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_thread ON summary_segments(thread_id);
CREATE INDEX IF NOT EXISTS idx_segments_thread_level ON summary_segments(thread_id, level);
CREATE INDEX IF NOT EXISTS idx_segments_topic ON summary_segments(topic_key);

CREATE TABLE IF NOT EXISTS summary_state (
  thread_id TEXT PRIMARY KEY,
  last_summarized_message_id TEXT,
  pending_message_count INTEGER NOT NULL DEFAULT 0,
  pending_token_count INTEGER NOT NULL DEFAULT 0,
  pending_signal_flags INTEGER NOT NULL DEFAULT 0,
  carry_over INTEGER NOT NULL DEFAULT 0,
  summary_type TEXT NOT NULL DEFAULT 'concat',
  last_abstractive_at TEXT,
  abstractive_token_count INTEGER
);
`;

// F139 Phase 1a: task run ledger
export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS task_run_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  signal_summary TEXT,
  duration_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_task ON task_run_ledger(task_id);
CREATE INDEX IF NOT EXISTS idx_run_ledger_subject ON task_run_ledger(subject_key);
`;

// F129 Phase A: pack-scoped knowledge isolation
export const SCHEMA_V6 = `
ALTER TABLE evidence_docs ADD COLUMN pack_id TEXT;
CREATE INDEX IF NOT EXISTS idx_evidence_docs_pack ON evidence_docs(pack_id);
`;

// F139 Phase 1b: actor receipt tracking
export const SCHEMA_V7 = `
ALTER TABLE task_run_ledger ADD COLUMN assigned_cat_id TEXT;
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

  if (currentVersion < 3) {
    db.exec(SCHEMA_V3_TABLE);
    db.exec(SCHEMA_V3_FTS);
    for (const stmt of PASSAGE_FTS_TRIGGER_STATEMENTS) db.exec(stmt);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
  }

  if (currentVersion < 4) {
    db.exec(SCHEMA_V4);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  if (currentVersion < 5) {
    db.exec(SCHEMA_V5);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  if (currentVersion < 6) {
    // ALTER TABLE cannot be combined; execute each statement separately
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN pack_id TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_pack ON evidence_docs(pack_id)');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  if (currentVersion < 7) {
    db.exec(SCHEMA_V7);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
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
