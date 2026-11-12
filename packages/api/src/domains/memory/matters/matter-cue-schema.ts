import type Database from 'better-sqlite3';

/** Add the explicit read shape while preserving every committed event and append-only guard. */
export function admitMatterCueFamily(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(memory_cue_events)').all() as Array<{ name: string }>;
  const hasOrigin = columns.some((column) => column.name === 'read_origin');
  const hasDetails = columns.some((column) => column.name === 'read_details_json');
  // A restored schema-version ledger can lag the physical table. Never rebuild
  // an already upgraded append-only ledger or erase its committed explicit reads.
  if (hasOrigin && hasDetails) return;
  if (hasOrigin || hasDetails) throw new Error('Incomplete matter cue ledger schema');
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_cue_events'")
    .get() as { sql: string };
  const dependents = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = 'memory_cue_events' AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  const ddl = table.sql
    .replace(/CREATE TABLE\s+["`]?memory_cue_events["`]?/i, 'CREATE TABLE memory_cue_events_matter')
    .replace("'thread_overview'", "'thread_overview', 'matter'")
    .replace(
      'created_at TEXT NOT NULL,',
      `created_at TEXT NOT NULL,
      read_origin TEXT NOT NULL DEFAULT 'push' CHECK (read_origin IN ('push', 'explicit_read')),
      read_details_json TEXT CHECK (read_details_json IS NULL OR json_valid(read_details_json)),`,
    )
    .replace(
      /\)\s*;?\s*$/,
      `,
      CHECK (CASE WHEN resolver_family = 'matter' THEN
        read_origin = 'explicit_read' AND read_details_json IS NOT NULL
        AND json_type(read_details_json) IS 'object'
        AND json_type(read_details_json, '$.matterId') IS 'text'
        AND length(json_extract(read_details_json, '$.matterId')) BETWEEN 1 AND 200
        AND json_type(read_details_json, '$.pageRevision') IS 'integer'
        AND json_extract(read_details_json, '$.pageRevision') > 0
        AND json_type(read_details_json, '$.entries') IS 'array'
        AND json_array_length(read_details_json, '$.entries') BETWEEN 1 AND 1000
        AND json_remove(read_details_json, '$.matterId', '$.pageRevision', '$.entries') = '{}'
        AND (axis = 'invalidation' OR consumption_outcome IN ('presented', 'drilled'))
      ELSE read_origin = 'push' AND read_details_json IS NULL END)
    )`,
    );
  db.exec(ddl);
  db.exec("INSERT INTO memory_cue_events_matter SELECT *, 'push', NULL FROM memory_cue_events");
  db.exec('DROP TABLE memory_cue_events');
  db.exec('ALTER TABLE memory_cue_events_matter RENAME TO memory_cue_events');
  for (const item of dependents) db.exec(item.sql);
  db.exec(`CREATE TRIGGER memory_cue_matter_entries_shape BEFORE INSERT ON memory_cue_events
    WHEN NEW.resolver_family = 'matter'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.read_details_json, '$.entries') AS entry
        WHERE json_type(entry.value) IS NOT 'object'
          OR json_type(entry.value, '$.entryId') IS NOT 'text'
          OR length(json_extract(entry.value, '$.entryId')) NOT BETWEEN 1 AND 200
          OR json_type(entry.value, '$.sourceRevision') IS NOT 'text'
          OR length(json_extract(entry.value, '$.sourceRevision')) NOT BETWEEN 1 AND 200
          OR json_remove(entry.value, '$.entryId', '$.sourceRevision') != '{}'
      ) THEN RAISE(ABORT, 'invalid matter read details') END;
    END`);
}
