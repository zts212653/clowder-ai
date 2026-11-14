import type Database from 'better-sqlite3';
import { installGenerationVectorTriggers } from './vector-generation-invalidation.js';

export type VectorGenerationId = 'g0' | 'g1';

/** Physical names are host-owned and never renamed, including on rollback. */
export interface VectorGenerationTables {
  readonly generationId: VectorGenerationId;
  readonly documents: string;
  readonly passages: string;
  readonly metadata: string;
  readonly documentSources: string;
  readonly passageSources: string;
}

const TABLES = Object.freeze(
  Object.fromEntries(
    (['g0', 'g1'] as const).map((generationId) => {
      const suffix = generationId === 'g0' ? '' : '_g1';
      return [
        generationId,
        Object.freeze({
          generationId,
          documents: `evidence_vectors${suffix}`,
          passages: `passage_vectors${suffix}`,
          metadata: `embedding_meta${suffix}`,
          documentSources: `document_vector_sources${suffix}`,
          passageSources: `passage_vector_sources${suffix}`,
        }),
      ];
    }),
  ),
) as Readonly<Record<VectorGenerationId, VectorGenerationTables>>;

export function vectorGenerationTables(id: VectorGenerationId = 'g0'): VectorGenerationTables {
  if (id !== 'g0' && id !== 'g1') throw new Error('Unknown vector generation');
  return TABLES[id];
}

/** Validate deserialized worker handles as well as local callers before SQL. */
export function validateVectorGenerationTables(tables: VectorGenerationTables): VectorGenerationTables {
  const expected = vectorGenerationTables(tables.generationId);
  for (const key of Object.keys(expected) as Array<keyof VectorGenerationTables>) {
    if (tables[key] !== expected[key]) throw new Error('Invalid vector generation table identifier');
  }
  return expected;
}

export function ensureGenerationVectorTable(
  db: Database.Database,
  dim: number,
  kind: 'documents' | 'passages',
  tables: VectorGenerationTables,
): boolean {
  try {
    const names = validateVectorGenerationTables(tables);
    if (!Number.isSafeInteger(dim) || dim < 1 || dim > 16384) return false;
    const table = names[kind];
    const column = kind === 'documents' ? 'anchor' : 'passage_key';
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(${column} TEXT PRIMARY KEY, embedding float[${dim}])`,
    );
    if (!generationVectorTableMatches(db, dim, kind, names)) return false;
    db.exec(`CREATE TABLE IF NOT EXISTS ${names.metadata}(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    installGenerationVectorTriggers(db, names, kind);
    return true;
  } catch {
    return false;
  }
}

/** Read workers verify existing vec0 declarations without creating anything. */
export function generationVectorTableMatches(
  db: Database.Database,
  dim: number,
  kind: 'documents' | 'passages',
  tables: VectorGenerationTables,
): boolean {
  const names = validateVectorGenerationTables(tables);
  const table = names[kind];
  const column = kind === 'documents' ? 'anchor' : 'passage_key';
  if (!Number.isSafeInteger(dim) || dim < 1 || dim > 16384) return false;
  const schema = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as { sql: string } | undefined;
  const shape = new RegExp(
    `^CREATE VIRTUAL TABLE\\s+${table}\\s+USING\\s+vec0\\(\\s*${column} TEXT PRIMARY KEY,\\s*embedding float\\[${dim}\\]\\s*\\)$`,
    'i',
  );
  return Boolean(schema && shape.test(schema.sql));
}
