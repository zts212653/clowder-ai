import type Database from 'better-sqlite3';

/** Preserve the immutable consumption ledger while admitting the one new source family. */
export function admitThreadOverviewCueFamily(db: Database.Database) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_cue_events'").get() as {
    sql: string;
  };
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='memory_cue_events' AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  const ddl = table.sql
    .replace(/CREATE TABLE\s+["`]?memory_cue_events["`]?/i, 'CREATE TABLE memory_cue_events_recall_v6')
    .replace("'cat_owned_seed'", "'cat_owned_seed', 'thread_overview'");
  db.exec(ddl);
  db.exec('INSERT INTO memory_cue_events_recall_v6 SELECT * FROM memory_cue_events');
  db.exec('DROP TABLE memory_cue_events');
  db.exec('ALTER TABLE memory_cue_events_recall_v6 RENAME TO memory_cue_events');
  for (const index of indexes) db.exec(index.sql);
}
