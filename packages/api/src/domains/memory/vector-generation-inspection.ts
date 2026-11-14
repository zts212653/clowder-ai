import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { runMemoryVectorGenerationRead, runMemoryVectorGenerationReconcile } from './MemoryProcess.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { reconcileGenerationInvalidations } from './vector-generation-invalidation.js';
import { inspectVectorGeneration, type VectorGenerationCoverage } from './vector-generation-readiness.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

export interface GenerationReadOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  allowBuilding?: boolean;
}

function databaseRevision(db: Database.Database): string {
  const { changes } = db.prepare('SELECT total_changes() AS changes').get() as { changes: number };
  return `${changes}:${db.pragma('data_version', { simple: true })}`;
}

export interface VectorCoverageProof {
  coverage: VectorGenerationCoverage;
  isCurrent(): boolean;
}

/** A file writer retains its queue slot until native maintenance really exits, including cancellation. */
export function reconcileStoreVectorGeneration(
  store: SqliteEvidenceStore,
  model: EmbedModelInfo,
  options: GenerationReadOptions = {},
): Promise<void> | void {
  const db = store.getDb();
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(tables.documents)) return;
  if (store.usesIsolatedProcesses())
    return runMemoryVectorGenerationReconcile(db.name, tables.generationId, {
      signal: options.signal,
      deadlineAt: options.deadlineAt ?? Date.now() + 15_000,
    });
  reconcileGenerationInvalidations(db, tables);
}

/** Caller owns writer admission, never a SQLite transaction across this await.
 * Both same-connection writes and other-connection commits retire the read snapshot.
 * No file-backed failure falls back to an API-thread scan. */
export async function inspectStoreVectorGeneration(
  store: SqliteEvidenceStore,
  model: EmbedModelInfo,
  options: GenerationReadOptions = {},
): Promise<VectorCoverageProof> {
  const db = store.getDb();
  const before = databaseRevision(db);
  const coverage = store.usesIsolatedProcesses()
    ? await runMemoryVectorGenerationRead<VectorGenerationCoverage>(
        {
          kind: 'vector-generation-read',
          operation: 'coverage',
          dbPath: db.name,
          model,
          allowBuilding: options.allowBuilding,
        },
        { signal: options.signal, deadlineAt: options.deadlineAt ?? Date.now() + 15_000 },
      )
    : inspectVectorGeneration(db, model, options);
  const isCurrent = () => db.open && databaseRevision(db) === before;
  return { coverage, isCurrent };
}
