import type { ListenRetention } from '@cat-cafe/shared';
import Database from 'better-sqlite3';

export interface DocumentRow {
  id: number;
  content_digest: string;
  synthesis_fingerprint: string;
  position_anchor: string | null;
  position_offset_seconds: number;
  playback_rate: number;
  retention: ListenRetention;
  updated_at: number;
}

export interface SentenceRow {
  anchor: string;
  asset_id: string | null;
  synthesis_fingerprint: string;
}

/** Create and migrate the small durable manifest schema; never stores sentence text. */
export function initializeDocumentListenSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS listen_documents (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      synthesis_fingerprint TEXT NOT NULL DEFAULT '',
      position_anchor TEXT,
      position_offset_seconds REAL NOT NULL DEFAULT 0,
      playback_rate REAL NOT NULL DEFAULT 1,
      retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever')),
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, project_path, relative_path)
    );
    CREATE TABLE IF NOT EXISTS listen_assets (
      asset_id TEXT PRIMARY KEY,
      last_used_at INTEGER NOT NULL,
      retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever'))
    );
    CREATE TABLE IF NOT EXISTS listen_sentence_assets (
      document_id INTEGER NOT NULL REFERENCES listen_documents(id) ON DELETE CASCADE,
      sentence_index INTEGER NOT NULL,
      anchor TEXT NOT NULL,
      asset_id TEXT REFERENCES listen_assets(asset_id) ON DELETE SET NULL,
      synthesis_fingerprint TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(document_id, anchor),
      UNIQUE(document_id, sentence_index)
    );
    CREATE INDEX IF NOT EXISTS idx_listen_sentence_asset_id ON listen_sentence_assets(asset_id);
  `);
  addColumnIfMissing(
    db,
    'listen_assets',
    'retention',
    "ALTER TABLE listen_assets ADD COLUMN retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever'))",
  );
  addColumnIfMissing(
    db,
    'listen_documents',
    'synthesis_fingerprint',
    "ALTER TABLE listen_documents ADD COLUMN synthesis_fingerprint TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    'listen_sentence_assets',
    'synthesis_fingerprint',
    "ALTER TABLE listen_sentence_assets ADD COLUMN synthesis_fingerprint TEXT NOT NULL DEFAULT ''",
  );
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, statement: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === column)) db.exec(statement);
}
