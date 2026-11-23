import type Database from 'better-sqlite3';
import type { IEmbeddingService } from './interfaces.js';
import type { PassageVectorStore } from './PassageVectorStore.js';
import { generationInvalidationState } from './vector-generation-invalidation.js';

export interface PassageWarmupState {
  source: string;
  vectorCount: number;
  /** Every passage row, embeddable or not. */
  passageCount: number;
}

/** Rows inserted after `id`. Passage ids only grow, and a rewritten passage is a deleted row plus a new one. */
export function countPassagesAfter(db: Database.Database, id: number): number {
  return (db.prepare('SELECT count(*) AS count FROM evidence_passages WHERE id > ?').get(id) as { count: number })
    .count;
}

/** A completed scan can be reused; unavailable evidence merely keeps the ordinary scan. */
export function readPassageWarmupState(
  db: Database.Database,
  vectors: PassageVectorStore | undefined,
  embedding: IEmbeddingService,
): PassageWarmupState | undefined {
  try {
    if (!vectors || !embedding.isReady()) return;
    return db.transaction(() => {
      const invalidation = generationInvalidationState(db, vectors.tables);
      if (invalidation.quarantined) return;
      // Canonical writers advance the existing epoch; cross-connection writes and
      // table recreation change SQLite versions. The key-map count also catches
      // a same-connection physical clear without inspecting vector payloads.
      const source = JSON.stringify([
        vectors.tables.passages,
        embedding.getModelInfo(),
        invalidation.epoch,
        db.pragma('data_version', { simple: true }),
        db.pragma('schema_version', { simple: true }),
      ]);
      const { count } = db.prepare(`SELECT count(*) AS count FROM ${vectors.tables.passages}_rowids`).get() as {
        count: number;
      };
      const passages = db.prepare('SELECT count(*) AS count FROM evidence_passages').get() as { count: number };
      return { source, vectorCount: count, passageCount: passages.count };
    })();
  } catch {
    return;
  }
}
