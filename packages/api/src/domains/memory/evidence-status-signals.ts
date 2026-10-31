/**
 * F188 Phase K — Memory Center Config Health Surface
 *
 * Spec: `docs/features/F188-library-stewardship.md` (Phase K, AC-K2)
 * Plan: `docs/plans/2026-06-09-f188-phase-k-config-health-surface.md` (Task 1)
 *
 * Goal: pure-function configuration health evaluator. Takes a 4-tier aggregate
 * of evidence-store/embedding-service/catalog state and returns:
 *   - `configWarnings[]`: user-actionable degradations with codes + suggestions
 *   - `functionalStatus`: 'ok' | 'degraded' (length-based, no severity)
 *
 * Used by `/api/evidence/status` route handler. Does NOT mutate the existing
 * `healthy` field semantic (KD-14 — external healthcheck backward compat).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import type { CollectionKind, CollectionStatus } from './collection-types.js';

// ---------- Types ----------

export type WarningCode =
  | 'docs_root_suspicious'
  | 'embedding_disabled'
  | 'vectors_empty'
  | 'graph_empty'
  | 'vec_table_missing';

export interface ConfigWarning {
  code: WarningCode;
  message: string;
  suggestedAction: string;
}

export interface CatalogCollectionSnapshot {
  id: string;
  root: string;
  kind: CollectionKind;
  /** undefined defaults to 'active' (per plan R4 — only 'archived' is skipped) */
  status?: CollectionStatus;
}

export interface EvidenceStatusSignals {
  dbCounts: {
    docs_count: number;
    edges_count: number;
    vectors_count: number;
    passage_vectors_count: number;
    threads_count: number;
    passages_count: number;
  };
  embeddingMeta: {
    embedding_model: string | null;
  };
  embeddingService: {
    passage_vectors_supported: boolean;
  };
  catalogSnapshot: {
    collections: CatalogCollectionSnapshot[];
  };
}

export type FunctionalStatus = 'ok' | 'degraded';

// ---------- Detectors ----------

interface SuspiciousFinding {
  id: string;
  reason: 'missing' | 'not_directory' | 'empty';
}

function inspectRoot(root: string): SuspiciousFinding['reason'] | null {
  let stat: ReturnType<typeof statSync>;
  try {
    if (!existsSync(root)) return 'missing';
    stat = statSync(root);
  } catch {
    // EACCES / EPERM / other fs errors → treat as missing for warning purposes
    return 'missing';
  }
  if (!stat.isDirectory()) return 'not_directory';
  try {
    const entries = readdirSync(root);
    if (entries.length === 0) return 'empty';
  } catch {
    return 'missing';
  }
  return null;
}

/**
 * AC-K2 detector: collection.root path is missing / not a directory / empty.
 *
 * Filter: `(m.status ?? 'active') !== 'archived'`
 *   - archived collections are intentionally retired; missing root is expected
 *   - registered/indexing/active/stale/blocked all participate
 *   - undefined status defaults to 'active' (per CollectionManifest.status optionality)
 */
export function detectDocsRootSuspicious(signals: EvidenceStatusSignals): ConfigWarning | null {
  const candidates = signals.catalogSnapshot.collections.filter((m) => (m.status ?? 'active') !== 'archived');
  const findings: SuspiciousFinding[] = [];
  for (const collection of candidates) {
    const reason = inspectRoot(collection.root);
    if (reason !== null) {
      findings.push({ id: collection.id, reason });
    }
  }
  if (findings.length === 0) return null;
  const idList = findings.map((f) => `${f.id} (${f.reason})`).join(', ');
  return {
    code: 'docs_root_suspicious',
    message: `Collection root paths look broken: ${idList}.`,
    suggestedAction:
      'Re-bind the collection root to an existing non-empty directory in Memory Center settings, or archive the collection if it is no longer needed.',
  };
}

/** AC-K2 detector: embedding_model is null → embeddings disabled. */
export function detectEmbeddingDisabled(signals: EvidenceStatusSignals): ConfigWarning | null {
  if (signals.embeddingMeta.embedding_model !== null) return null;
  return {
    code: 'embedding_disabled',
    message: 'No embedding model is configured — semantic recall is offline.',
    suggestedAction:
      'Install and start the recommended local embedding service in Memory Center, then rebuild the index.',
  };
}

/** AC-K2 detector: vectors_count === 0 && docs_count > 0 → vector index empty. */
export function detectVectorsEmpty(signals: EvidenceStatusSignals): ConfigWarning | null {
  const { docs_count, vectors_count } = signals.dbCounts;
  if (vectors_count !== 0 || docs_count <= 0) return null;
  return {
    code: 'vectors_empty',
    message: `Documents are indexed (${docs_count}) but the vector index is empty — semantic recall will not return results.`,
    suggestedAction:
      'Run a full reindex (Memory Center → Rebuild Index) to compute vectors for the ingested documents.',
  };
}

/** AC-K2 detector: edges_count === 0 && docs_count > 0 → graph not built. */
export function detectGraphEmpty(signals: EvidenceStatusSignals): ConfigWarning | null {
  const { docs_count, edges_count } = signals.dbCounts;
  if (edges_count !== 0 || docs_count <= 0) return null;
  return {
    code: 'graph_empty',
    message: `Documents are indexed (${docs_count}) but the knowledge graph has no edges — graph-aware recall will be limited.`,
    suggestedAction:
      'Run graph extraction (Memory Center → Rebuild Index). If edges remain empty after rebuild, check the extractor logs for failures.',
  };
}

/** AC-K2 detector: passage_vectors_supported === false → sqlite-vec / embed off. */
export function detectVecTableMissing(signals: EvidenceStatusSignals): ConfigWarning | null {
  if (signals.embeddingService.passage_vectors_supported) return null;
  return {
    code: 'vec_table_missing',
    message: 'Passage vector table is unavailable (sqlite-vec not loaded or embedding service not ready).',
    suggestedAction:
      'Open the local embedding service controls to start or reinstall it; unsupported platforms will show a platform-specific error.',
  };
}

// ---------- Aggregators ----------

/**
 * AC-K2: aggregate all 5 detectors into a non-null ConfigWarning array.
 * Order is stable (same as 5-detector enum order) for snapshot stability.
 */
export function evaluateConfigWarnings(signals: EvidenceStatusSignals): ConfigWarning[] {
  const detectors = [
    detectDocsRootSuspicious,
    detectEmbeddingDisabled,
    detectVectorsEmpty,
    detectGraphEmpty,
    detectVecTableMissing,
  ];
  const warnings: ConfigWarning[] = [];
  for (const detect of detectors) {
    const warning = detect(signals);
    if (warning !== null) warnings.push(warning);
  }
  return warnings;
}

/**
 * AC-K1 + KD-14: derive functionalStatus from warnings length.
 * Does NOT touch `healthy` field (caller composes both).
 */
export function computeFunctionalStatus(warnings: ConfigWarning[]): FunctionalStatus {
  return warnings.length > 0 ? 'degraded' : 'ok';
}
