import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { quarantineGenerationInvalidations } from './vector-generation-invalidation.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

/** Source mutation owns invalidation, independently of provider readiness.
 * Register an existing native table on cold/off connections; never create one. */
export function createVectorInvalidator(
  db: Database.Database,
  table: 'passage_vectors' | 'evidence_vectors',
): (key: string) => void {
  const column = table === 'passage_vectors' ? 'passage_key' : 'anchor';
  const exists = db.prepare('SELECT sql FROM sqlite_master WHERE name=?');
  const removers: Array<(key: string) => void> = [];
  let nativeAvailable = Boolean(db.prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get());
  if (
    !nativeAvailable &&
    ['evidence_vectors', 'passage_vectors', 'evidence_vectors_g1', 'passage_vectors_g1'].some((name) => {
      const row = exists.get(name) as { sql: string } | undefined;
      return row && /USING\s+vec0\b/i.test(row.sql);
    })
  ) {
    try {
      sqliteVec.load(db);
      nativeAvailable = true;
    } catch {
      quarantineGenerationInvalidations(db);
    }
  }
  for (const id of ['g0', 'g1'] as const) {
    const tables = vectorGenerationTables(id);
    const name = table === 'passage_vectors' ? tables.passages : tables.documents;
    const sources = table === 'passage_vectors' ? tables.passageSources : tables.documentSources;
    const schema = exists.get(name) as { sql: string } | undefined;
    if (schema && (!/USING\s+vec0\b/i.test(schema.sql) || nativeAvailable)) {
      const remove = db.prepare(`DELETE FROM ${name} WHERE ${column}=?`);
      removers.push((key) => {
        remove.run(key);
      });
    }
    if (exists.get(sources)) {
      if (nativeAvailable || !schema) {
        const remove = db.prepare(`DELETE FROM ${sources} WHERE ${column}=?`);
        removers.push((key) => {
          remove.run(key);
        });
      } else {
        const mark =
          table === 'evidence_vectors'
            ? db.prepare(
                `INSERT INTO ${sources}(anchor,source_hash,revision_hash) VALUES(?,'','invalidated') ON CONFLICT(anchor) DO UPDATE SET source_hash='',revision_hash='invalidated'`,
              )
            : db.prepare(
                `INSERT INTO ${sources}(passage_key,revision_hash) VALUES(?,'invalidated') ON CONFLICT(passage_key) DO UPDATE SET revision_hash='invalidated'`,
              );
        removers.push((key) => {
          mark.run(key);
        });
      }
    }
  }
  return (key) => {
    for (const remove of removers) remove(key);
  };
}
