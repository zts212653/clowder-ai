import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/** Source mutation owns invalidation, independently of provider readiness.
 * Register an existing native table on cold/off connections; never create one. */
export function createVectorInvalidator(
  db: Database.Database,
  table: 'passage_vectors' | 'evidence_vectors',
): (key: string) => void {
  const schema = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as { sql: string } | undefined;
  if (!schema) return () => {};
  if (/USING\s+vec0\b/i.test(schema.sql) && !db.prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get())
    sqliteVec.load(db);
  const column = table === 'passage_vectors' ? 'passage_key' : 'anchor';
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${column}=?`);
  return (key) => {
    remove.run(key);
  };
}
