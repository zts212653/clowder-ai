import type Database from 'better-sqlite3';

/** Opportunity coordinates only. All consumption continues in memory_cue_events. */
export function installWorkPreparationSchema(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_cue_events'").get() as {
    sql: string;
  };
  const upgraded = table.sql.includes("'message_evidence'");
  if (upgraded && !table.sql.includes("opportunity_id LIKE 'preparation-%'"))
    throw new Error('Incomplete preparation ledger schema');
  if (!upgraded) {
    const dependents = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='memory_cue_events' AND sql IS NOT NULL",
      )
      .all() as { sql: string }[];
    const ddl = table.sql
      .replace(/CREATE TABLE\s+["`]?memory_cue_events["`]?/i, 'CREATE TABLE memory_cue_events_preparation')
      .replace(/(resolver_family[^\n]*?IN\s*\([^)]*)\)/, "$1, 'message_evidence')")
      .replace(
        "ELSE read_origin = 'push' AND read_details_json IS NULL END",
        "ELSE (read_origin = 'push' OR (read_origin = 'explicit_read' AND opportunity_id LIKE 'preparation-%')) AND read_details_json IS NULL END",
      );
    if (!ddl.includes("'message_evidence'") || !ddl.includes("opportunity_id LIKE 'preparation-%'"))
      throw new Error('Unexpected cue ledger schema for preparation migration');
    db.exec(ddl);
    db.exec('INSERT INTO memory_cue_events_preparation SELECT * FROM memory_cue_events');
    db.exec('DROP TABLE memory_cue_events');
    db.exec('ALTER TABLE memory_cue_events_preparation RENAME TO memory_cue_events');
    for (const dependent of dependents) db.exec(dependent.sql);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_cue_preparation_opportunities (
    opportunity_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL, thread_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    consumer_cat_id TEXT NOT NULL, context_epoch INTEGER NOT NULL CHECK(context_epoch > 0),
    source_message_id TEXT NOT NULL, project_path TEXT NOT NULL, activity TEXT NOT NULL CHECK(activity IN ('html','video')),
    query_digest TEXT NOT NULL, occurred_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    coordinates_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(coordinates_json)),
    result_status TEXT NOT NULL DEFAULT 'received', discovery_version TEXT,
    source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids_json)),
    discovery_sources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(discovery_sources_json))
  );
  CREATE INDEX IF NOT EXISTS idx_memory_preparation_context ON memory_cue_preparation_opportunities
    (owner_user_id,thread_id,consumer_cat_id,context_epoch,activity,query_digest);`);
}
