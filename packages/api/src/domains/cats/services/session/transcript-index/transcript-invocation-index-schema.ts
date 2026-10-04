import { setTimeout } from 'node:timers/promises';
import type Database from 'better-sqlite3';

export const TRANSCRIPT_INVOCATION_INDEX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sources (
    source INTEGER PRIMARY KEY, signature TEXT NOT NULL, inode TEXT NOT NULL,
    size INTEGER NOT NULL, next_offset INTEGER NOT NULL, head_hash TEXT NOT NULL, tail_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_events (
    source INTEGER NOT NULL, seq INTEGER NOT NULL, event_no INTEGER NOT NULL, invocation_id TEXT,
    hash TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL, projection TEXT NOT NULL,
    files_touched TEXT NOT NULL,
    PRIMARY KEY(source, seq)
  );
  CREATE INDEX IF NOT EXISTS source_events_offset ON source_events(source, byte_offset);
  CREATE INDEX IF NOT EXISTS source_events_hash ON source_events(source, hash, seq);
  CREATE TABLE IF NOT EXISTS canonical (
    logical_no INTEGER PRIMARY KEY, source INTEGER NOT NULL, seq INTEGER NOT NULL,
    event_no INTEGER NOT NULL, invocation_id TEXT, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
    projection TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS canonical_invocation ON canonical(invocation_id, logical_no);
  CREATE TABLE IF NOT EXISTS summaries (
    invocation_id TEXT PRIMARY KEY, started_at REAL NOT NULL, projection TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS summaries_order ON summaries(started_at DESC, invocation_id);
  CREATE TABLE IF NOT EXISTS cache (id INTEGER PRIMARY KEY CHECK(id = 1), key TEXT NOT NULL);
`;

/** Contention never enters a native busy-wait; worker cancellation can interrupt this wait. */
export async function beginTranscriptIndexUpdate(db: Database.Database): Promise<void> {
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
      await setTimeout(25);
    }
  }
}
