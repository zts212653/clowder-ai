import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { FileVectorQueryReader } from './file-vector-read-window.js';
import type { EmbedModelInfo } from './interfaces.js';
import { PassageVectorStore } from './PassageVectorStore.js';
import { VectorStore } from './VectorStore.js';
import { canInitializeVectorIdentity, vectorIdentityMatches } from './vector-generation-identity.js';
import { reconcileGenerationInvalidations } from './vector-generation-invalidation.js';
import {
  ensureGenerationVectorTable,
  generationVectorTableMatches,
  vectorGenerationTables,
} from './vector-generation-tables.js';

export interface VectorBackend {
  vectorStore: VectorStore;
  passageVectorStore: PassageVectorStore;
}

/** The one constructor boundary for default, collection, builder and file reader. */
export function openVectorGeneration(
  db: Database.Database,
  model: EmbedModelInfo,
  options: { create?: boolean; readQuery?: FileVectorQueryReader; passages?: boolean; reconcile?: boolean } = {},
): VectorBackend {
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  if (tables.generationId !== 'g0' && !model.representationFingerprint)
    throw new Error('Vector generation identity is required');
  sqliteVec.load(db);
  const ownedMeta = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(tables.metadata);
  if (ownedMeta && !canInitializeVectorIdentity(db, model))
    throw new Error('Vector generation identity mismatch or unknown');
  if (ownedMeta && model.representationFingerprint) {
    const existing = new VectorStore(db, model.dim, tables);
    if (existing.getMeta().embedding_model_id && !existing.checkMetaConsistency(model).consistent)
      throw new Error('Vector generation identity mismatch');
  }
  for (const kind of ['documents', 'passages'] as const) {
    if (kind === 'passages' && options.passages === false) continue;
    const ready = options.create
      ? ensureGenerationVectorTable(db, model.dim, kind, tables)
      : generationVectorTableMatches(db, model.dim, kind, tables);
    if (!ready) throw new Error('Vector generation table is unavailable or has the wrong dimension');
  }
  if (options.create && options.reconcile !== false) reconcileGenerationInvalidations(db, tables);
  const vectorStore = new VectorStore(db, model.dim, tables);
  if (!options.create && !vectorIdentityMatches(db, model)) throw new Error('Vector generation identity mismatch');
  return { vectorStore, passageVectorStore: new PassageVectorStore(db, model.dim, options.readQuery, tables) };
}
