import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { openVectorGeneration } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import {
  canInitializeVectorIdentity,
  generationIdentity,
  vectorIdentityMatches,
} from './vector-generation-identity.js';
import {
  type GenerationReadOptions,
  inspectStoreVectorGeneration,
  reconcileStoreVectorGeneration,
  type VectorCoverageProof,
} from './vector-generation-inspection.js';
import { prepareGenerationInvalidationConnection } from './vector-generation-invalidation.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

/** Unregistered legacy G0 stays incremental; an adopted cohort keeps its coverage contract after a pause/restart.
 * The one admission that does not need zero pending sources is `isServableCohortTail` below. */
export function requiresCohortCoverage(stores: SqliteEvidenceStore[], model: EmbedModelInfo): boolean {
  return (
    (model.generationId ?? 'g0') === 'g1' ||
    stores.some(
      (store) =>
        !canInitializeVectorIdentity(store.getDb(), model) ||
        Boolean(
          store.getDb().prepare("SELECT 1 FROM vector_generations WHERE id='g0' OR (id='g1' AND state='ready')").get(),
        ),
    )
  );
}

/**
 * A G0 that was verified complete, and is the only generation that ever was, keeps serving the
 * vectors it has when it is admitted again (process restart, sidecar ready callback).
 *
 * What it lacks is the unembedded tail every running index carries: new sources wait for the
 * incremental encoder, and nothing re-inspects coverage once an index is bound. Requiring that
 * tail to be exactly zero at admission is stricter than steady state and withdrew an index that
 * was over 99% present for the whole catch-up (boot92, 2026-11-16: fifteen minutes lexical-only).
 * A present G0 vector is already the coverage proof's evidence of validity, so admitting with a
 * tail exposes nothing that complete admission would not; only absent vectors differ.
 *
 * The full contract stays for everything that is not a restart of the serving index: a
 * replacement still `building`, another identity, quarantine, orphan vectors, and any store in
 * which G1 has been completed, where activation may be a switch between generations. Telling a
 * restart from a switch there needs a durable record of the last published generation.
 *
 * Like complete admission, this is decided on a proof that still describes the store. Any commit
 * overtakes a proof, a quarantine as readily as a new source, so an overtaken proof admits nothing.
 */
export function isServableCohortTail(
  db: Database.Database,
  model: EmbedModelInfo,
  proof: VectorCoverageProof,
): boolean {
  const { coverage } = proof;
  if ((model.generationId ?? 'g0') !== 'g0') return false;
  if (coverage.reason !== 'coverage_incomplete') return false;
  if (coverage.orphanDocuments + coverage.orphanPassages > 0) return false;
  const registry = db.prepare('SELECT id,fingerprint,state FROM vector_generations').all() as Array<{
    id: string;
    fingerprint: string;
    state: string;
  }>;
  const g0 = registry.find((row) => row.id === 'g0');
  return (
    g0?.state === 'ready' &&
    g0.fingerprint === generationIdentity(model) &&
    !registry.some((row) => row.id === 'g1' && row.state === 'ready') &&
    vectorIdentityMatches(db, model) &&
    // Last, so that it also covers the registry and identity just read.
    proof.isCurrent()
  );
}

/** Reads of a store whose proof keeps being overtaken before the caller treats it as not admitted. */
const ADMISSION_LOOKS = 3;

/**
 * The proof admission is decided on. One overtaken by a commit is read again instead of being
 * interpreted. Being overtaken is routine (boot92: 2 of 19 inspections), and a store that is not
 * admitted goes through a repair cycle with its vector reads withdrawn.
 */
export async function inspectCohortAdmission(
  store: SqliteEvidenceStore,
  model: EmbedModelInfo,
  lifetime: GenerationReadOptions,
  isCurrent: () => boolean,
): Promise<VectorCoverageProof> {
  let proof = await inspectStoreVectorGeneration(store, model, lifetime);
  for (let look = 1; look < ADMISSION_LOOKS && !proof.isCurrent() && isCurrent(); look++)
    proof = await inspectStoreVectorGeneration(store, model, lifetime);
  return proof;
}

/** Recovery of a previously complete G1 is distinct from an explicit first shadow build. */
export async function inspectCohortRecovery(
  stores: SqliteEvidenceStore[],
  model: EmbedModelInfo,
  rebuildLegacy: boolean,
  isCurrent: () => boolean,
  coverageRequired = true,
  lifetime: GenerationReadOptions = {},
): Promise<'ready' | 'repair' | 'blocked'> {
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  let repair = false;
  for (const [storeIndex, store] of stores.entries()) {
    if (!isCurrent()) return 'blocked';
    const state = await store.runExclusive(async () => {
      if (!isCurrent()) return 'blocked';
      const db = store.getDb();
      prepareGenerationInvalidationConnection(db);
      await reconcileStoreVectorGeneration(store, model, lifetime);
      if (!isCurrent()) return 'blocked';
      if (!coverageRequired && tables.generationId === 'g0')
        return canInitializeVectorIdentity(db, model) ? 'ready' : 'blocked';
      const proof = await inspectCohortAdmission(store, model, lifetime, isCurrent);
      if (!isCurrent()) return 'blocked';
      if (proof.coverage.ready && proof.isCurrent()) return 'ready';
      if (isServableCohortTail(db, model, proof)) {
        try {
          console.warn('[memory] vector cohort admitted with an unembedded tail', {
            generationId: tables.generationId,
            storeIndex,
            missingDocuments: proof.coverage.missingDocuments,
            missingPassages: proof.coverage.missingPassages,
          });
        } catch {
          // An optional log sink has no admission authority.
        }
        return 'ready';
      }
      try {
        const reason = proof.isCurrent() ? (proof.coverage.reason ?? 'unknown') : 'concurrent_mutation';
        const coverage = proof.coverage;
        console.warn('[memory] vector cohort admission incomplete', {
          generationId: tables.generationId,
          storeIndex,
          reason,
          ...(reason === 'coverage_incomplete'
            ? {
                missingDocuments: coverage.missingDocuments,
                missingPassages: coverage.missingPassages,
                orphanDocuments: coverage.orphanDocuments,
                orphanPassages: coverage.orphanPassages,
              }
            : {}),
        });
      } catch {
        // An optional log sink has no admission authority.
      }
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
        // Persist the cohort contract in the same transaction that replaces
        // identity. A crash before the first encode cannot adopt empty G0 as
        // an ordinary legacy index; later windows retain full-cohort admission.
        db.prepare("INSERT INTO vector_generations(id,fingerprint,state) VALUES('g0',?,'building')").run(
          generationIdentity(model),
        );
      })();
    });
}
