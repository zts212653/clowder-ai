import type Database from 'better-sqlite3';

/**
 * Columns the migration ladder adds with ALTER TABLE.
 *
 * schema_version is one counter shared by the upstream and fork lineages: a DB an older lineage
 * already stamped at N silently skips upstream's block N after a sync. 2026-09-07: every live DB
 * read 42 while 25/26 lacked V40's dynamic_task_defs.entrusted_work_reevaluation_json, so every
 * DynamicTaskStore insert (hold_ball, scheduled tasks) failed with SQLITE_ERROR.
 *
 * Column presence is the truth, not the stamp: applyMigrations reconciles this list on every pass.
 * Idempotent and stamp-neutral — it never inserts into schema_version.
 */
const LADDER_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'dynamic_task_defs', column: 'entrusted_work_reevaluation_json', ddl: 'TEXT' }, // V40
  { table: 'dynamic_task_defs', column: 'retry_attempts', ddl: 'INTEGER DEFAULT 0' }, // V42
];

function presentColumns(db: Database.Database, table: string): Set<string> | null {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.length === 0 ? null : new Set(rows.map((row) => row.name));
}

/** Add every ladder column that is missing; returns the `table.column` names added. */
export function reconcileLadderColumns(db: Database.Database): string[] {
  const added: string[] = [];
  const seen = new Map<string, Set<string> | null>();
  for (const { table, column, ddl } of LADDER_COLUMNS) {
    if (!seen.has(table)) seen.set(table, presentColumns(db, table));
    const columns = seen.get(table);
    // The ladder owns table creation; a table that does not exist yet is not ours to repair.
    if (!columns || columns.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    columns.add(column);
    added.push(`${table}.${column}`);
  }
  return added;
}
