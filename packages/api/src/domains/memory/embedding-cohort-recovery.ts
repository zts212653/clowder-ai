import type { EmbedModelInfo } from './interfaces.js';
import { openVectorGeneration } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { canInitializeVectorIdentity, vectorIdentityMatches } from './vector-generation-identity.js';
import {
  prepareGenerationInvalidationConnection,
  reconcileGenerationInvalidations,
} from './vector-generation-invalidation.js';
import { inspectVectorGeneration } from './vector-generation-readiness.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

/** Installing this code does not turn a legacy incremental index into a full startup build. */
export function requiresCohortCoverage(stores: SqliteEvidenceStore[], model: EmbedModelInfo): boolean {
  return (
    (model.generationId ?? 'g0') === 'g1' ||
    stores.some(
      (store) =>
        !canInitializeVectorIdentity(store.getDb(), model) ||
        Boolean(store.getDb().prepare("SELECT 1 FROM vector_generations WHERE id='g1' AND state='ready'").get()),
    )
  );
}

/** Recovery of a previously complete G1 is distinct from an explicit first shadow build. */
export async function inspectCohortRecovery(
  stores: SqliteEvidenceStore[],
  model: EmbedModelInfo,
  rebuildLegacy: boolean,
  isCurrent: () => boolean,
  coverageRequired = true,
): Promise<'ready' | 'repair' | 'blocked'> {
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  let repair = false;
  for (const store of stores) {
    if (!isCurrent()) return 'blocked';
    const state = await store.runExclusive(() => {
      if (!isCurrent()) return 'blocked';
      const db = store.getDb();
      prepareGenerationInvalidationConnection(db);
      if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(tables.documents))
        reconcileGenerationInvalidations(db, tables);
      if (!coverageRequired && tables.generationId === 'g0')
        return canInitializeVectorIdentity(db, model) ? 'ready' : 'blocked';
      if (inspectVectorGeneration(db, model).ready) return 'ready';
      if (tables.generationId === 'g0')
        return canInitializeVectorIdentity(db, model) || rebuildLegacy ? 'repair' : 'blocked';
      const registry = db.prepare('SELECT fingerprint,state FROM vector_generations WHERE id=?').get('g1') as
        | { fingerprint: string; state: string }
        | undefined;
      return registry?.state === 'ready' &&
        registry.fingerprint === model.representationFingerprint &&
        vectorIdentityMatches(db, model)
        ? 'repair'
        : 'blocked';
    });
    if (state === 'blocked') return 'blocked';
    if (state === 'repair') repair = true;
  }
  return repair ? 'repair' : 'ready';
}

/** Explicit G0 reconfiguration retires every old handle before any identity is replaced. */
export async function resetLegacyCohort(
  stores: SqliteEvidenceStore[],
  model: EmbedModelInfo,
  isCurrent: () => boolean,
): Promise<void> {
  const tables = vectorGenerationTables('g0');
  for (const store of stores)
    await store.runExclusive(() => {
      if (!isCurrent()) throw new Error('Legacy rebuild retired');
      const db = store.getDb();
      if (canInitializeVectorIdentity(db, model)) return;
      db.transaction(() => {
        // Epoch survives the reset and also retires already prepared file-reader results.
        db.exec(`INSERT INTO ${tables.metadata}(key,value) VALUES('vector_invalidation_epoch','1')
        ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`);
        for (const kind of ['documents', 'passages'] as const) db.exec(`DROP TABLE IF EXISTS ${tables[kind]}`);
        db.exec(`DELETE FROM ${tables.documentSources}; DELETE FROM ${tables.passageSources};
        DELETE FROM ${tables.metadata} WHERE key NOT IN ('indexing_version','document_source_claims','vector_invalidation_epoch');
        DELETE FROM vector_generations WHERE id='g0'`);
        // No queue boundary may expose TEMP canonical triggers pointing at a
        // dropped physical table, including a same-dimensional reconfiguration.
        const backend = openVectorGeneration(db, model, { create: true });
        backend.vectorStore.initMeta(model);
      })();
    });
}
