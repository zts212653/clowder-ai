import type Database from 'better-sqlite3';

/** Canonical memory facts: no FK to the rebuildable evidence index, no TTL. */
export const MATTER_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_matters (
  matter_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_matters_owner ON memory_matters(owner_user_id, matter_id);
CREATE TABLE IF NOT EXISTS memory_matter_entries (
  entry_id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES memory_matters(matter_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retired')),
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(matter_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_matter_entries ON memory_matter_entries(matter_id, entry_id);
CREATE TABLE IF NOT EXISTS memory_matter_requests (
  owner_user_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY(owner_user_id, actor_key, request_id)
);
CREATE TABLE IF NOT EXISTS memory_matter_forget_fences (
  owner_user_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, matter_id)
);
`;

/** Additive migration: historical summaries keep an unknown author and original source JSON. */
export function addMatterSummaries(db: Database.Database): void {
  for (const [table, definitions] of [
    [
      'memory_matters',
      [
        'description_author_json TEXT CHECK (description_author_json IS NULL OR json_valid(description_author_json))',
        'description_entry_id TEXT',
        'access_guards_json TEXT CHECK (access_guards_json IS NULL OR json_valid(access_guards_json))',
      ],
    ],
    [
      'memory_matter_entries',
      [
        'summary TEXT',
        'summary_author_json TEXT CHECK (summary_author_json IS NULL OR json_valid(summary_author_json))',
      ],
    ],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const definition of definitions) {
      if (!columns.some((column) => column.name === definition.split(' ')[0]))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
  // Both kinds are content-free read evidence. An entry revision never proves an original was read.
  db.exec(`DROP TRIGGER IF EXISTS memory_cue_matter_entries_shape;
    CREATE TRIGGER memory_cue_matter_entries_shape BEFORE INSERT ON memory_cue_events
    WHEN NEW.resolver_family = 'matter'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.read_details_json, '$.entries') AS entry
        WHERE json_type(entry.value) IS NOT 'object'
          OR json_type(entry.value, '$.entryId') IS NOT 'text'
          OR length(json_extract(entry.value, '$.entryId')) NOT BETWEEN 1 AND 200
          OR NOT (
            (json_type(entry.value, '$.sourceRevision') IS 'text'
             AND length(json_extract(entry.value, '$.sourceRevision')) BETWEEN 1 AND 200
             AND json_remove(entry.value, '$.entryId', '$.sourceRevision') = '{}')
            OR (json_type(entry.value, '$.entryRevision') IS 'text'
             AND length(json_extract(entry.value, '$.entryRevision')) BETWEEN 1 AND 200
             AND json_remove(entry.value, '$.entryId', '$.entryRevision') = '{}')
          )
      ) THEN RAISE(ABORT, 'invalid matter read details') END;
    END`);
}
