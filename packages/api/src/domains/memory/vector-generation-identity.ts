import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

/** Legacy identity proves only the model/dimension pair, never a complete G1 recipe. */
export function generationIdentity(model: EmbedModelInfo): string {
  if ((model.generationId ?? 'g0') === 'g1') {
    if (!model.representationFingerprint) throw new Error('Missing representation identity');
    return model.representationFingerprint;
  }
  return `legacy:${createHash('sha256')
    .update(JSON.stringify([model.modelId, model.dim]))
    .digest('hex')}`;
}

export function vectorIdentityMatches(db: Database.Database, model: EmbedModelInfo): boolean {
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(tables.metadata)) return false;
  const meta = Object.fromEntries(
    (db.prepare(`SELECT key,value FROM ${tables.metadata}`).all() as Array<{ key: string; value: string }>).map((r) => [
      r.key,
      r.value,
    ]),
  );
  return (
    meta.embedding_model_id === model.modelId &&
    meta.embedding_dim === String(model.dim) &&
    (!model.representationFingerprint || meta.embedding_representation_fingerprint === model.representationFingerprint)
  );
}

/** Empty, unowned tables are initializable. Existing unknown rows are never adopted as a new model. */
export function canInitializeVectorIdentity(db: Database.Database, model: EmbedModelInfo): boolean {
  if (vectorIdentityMatches(db, model)) return true;
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
  if (
    exists.get(tables.metadata) &&
    db.prepare(`SELECT 1 FROM ${tables.metadata} WHERE key='embedding_model_id'`).get()
  )
    return false;
  return (['documents', 'passages'] as const).every(
    (kind) => !exists.get(tables[kind]) || !db.prepare(`SELECT 1 FROM ${tables[kind]}_rowids LIMIT 1`).get(),
  );
}

/** G0 retains its existing V48/physical-membership compatibility, explicitly short of full revision proof. */
export function missingVectorSource(kind: 'documents' | 'passages', generation: 'g0' | 'g1'): string {
  if (generation === 'g1') return "v.id IS NULL OR s.revision_hash IS NULL OR s.revision_hash='invalidated'";
  return `v.id IS NULL OR s.revision_hash='invalidated'${kind === 'documents' ? ' OR (s.source_hash IS NOT NULL AND s.source_hash IS NOT d.source_hash)' : ''}`;
}
