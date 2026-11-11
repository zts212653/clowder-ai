'use client';
import { type EvidenceFlag } from './EvidenceFeatureFlag';

// F188 Phase K: shared types for config-warning surface (AC-K1/K3/K4)
export type FunctionalStatus = 'ok' | 'degraded';

export type ConfigWarningCode =
  | 'docs_root_suspicious'
  | 'embedding_disabled'
  | 'vectors_empty'
  | 'graph_empty'
  | 'vec_table_missing';

export interface ConfigWarning {
  code: ConfigWarningCode;
  message: string;
  suggestedAction: string;
}

interface RawStatusResponse {
  backend: string;
  healthy: boolean;
  docs_count?: number;
  vectors_count?: number;
  threads_count?: number;
  passages_count?: number;
  passage_vectors_count?: number;
  passage_vectors_supported?: boolean;
  passage_warmup_active?: boolean;
  edges_count?: number;
  last_rebuild_at?: string | null;
  last_document_updated_at?: string | null;
  embedding_model?: string | null;
  reason?: string;
  // F188 Phase K extension
  functionalStatus?: FunctionalStatus;
  configWarnings?: ConfigWarning[];
}

export interface IndexStatusData {
  backend: string;
  healthy: boolean;
  docsCount: number;
  vectorsCount: number;
  threadsCount: number;
  passagesCount: number;
  passageVectorsCount: number;
  passageVectorsSupported: boolean;
  passageWarmupActive: boolean;
  edgesCount: number;
  lastRebuildAt: string | null;
  lastDocumentUpdatedAt: string | null;
  embeddingModel: string | null;
  reason?: string;
  // F188 Phase K — default `'ok'` + `[]` when API omits them (older backend).
  functionalStatus: FunctionalStatus;
  configWarnings: ConfigWarning[];
}

/**
 * Pure: parse raw API response into normalized status data.
 */
export function parseIndexStatus(raw: RawStatusResponse): IndexStatusData {
  return {
    backend: raw.backend,
    healthy: raw.healthy,
    docsCount: raw.docs_count ?? 0,
    vectorsCount: raw.vectors_count ?? 0,
    threadsCount: raw.threads_count ?? 0,
    passagesCount: raw.passages_count ?? 0,
    passageVectorsCount: raw.passage_vectors_count ?? 0,
    passageVectorsSupported: raw.passage_vectors_supported ?? false,
    passageWarmupActive: raw.passage_warmup_active ?? false,
    edgesCount: raw.edges_count ?? 0,
    lastRebuildAt: raw.last_rebuild_at ?? null,
    lastDocumentUpdatedAt: raw.last_document_updated_at ?? null,
    embeddingModel: raw.embedding_model ?? null,
    reason: raw.reason,
    functionalStatus: raw.functionalStatus ?? 'ok',
    configWarnings: raw.configWarnings ?? [],
  };
}

/**
 * F188 Phase K (AC-K4): pure predicate — does the degraded banner show?
 *
 * Rules:
 *   - healthy=false → caller renders the red fatal badge; we do NOT also
 *     show the yellow degraded banner (red takes precedence per plan KD-15)
 *   - functionalStatus='degraded' + at least one warning → show
 *   - everything else → hide
 */
export function shouldShowDegradedBanner(status: IndexStatusData): boolean {
  if (!status.healthy) return false;
  return status.functionalStatus === 'degraded' && status.configWarnings.length > 0;
}

/**
 * F188 Phase K (AC-K4): map warning code → target section id in IndexStatus.
 * Used by `handleWarningClick` to scroll the right config surface into view.
 * Exposed for test reuse.
 */
export const WARNING_ACTION_TARGETS: Record<ConfigWarningCode, string> = {
  docs_root_suspicious: 'evidence-config-vars',
  embedding_disabled: 'embedding-service-controls',
  vectors_empty: 'rebuild-controls',
  graph_empty: 'rebuild-controls',
  vec_table_missing: 'embedding-service-controls',
};

/**
 * F209 Pure: is passage-vector embedding still warming up in the background?
 * True only when passage vectors are SUPPORTED (sqlite-vec available / embedding on) and there
 * are passages whose vectors are not all computed yet. When unsupported (embed off / no vec table),
 * the count stays 0 forever — this guard prevents a perpetual "warming up" banner + 3s poll loop.
 */
export function isEmbeddingWarmingUp(status: IndexStatusData): boolean {
  return (
    status.passageVectorsSupported && status.passagesCount > 0 && status.passageVectorsCount < status.passagesCount
  );
}

// ── F188 Phase A: Rebuild job types + parser ──

interface RawRebuildJob {
  id: string;
  status: string;
  phase: string;
  percent: number;
  error?: string;
  result?: { docsIndexed: number; docsSkipped: number; durationMs: number };
  startedAt: number;
  completedAt?: number;
}

export interface RebuildJobData {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  error?: string;
  result?: { docsIndexed: number; docsSkipped: number; durationMs: number };
  startedAt: number;
  completedAt?: number;
}

export function parseRebuildJob(raw: RawRebuildJob): RebuildJobData {
  return {
    id: raw.id,
    status: raw.status as RebuildJobData['status'],
    phase: raw.phase,
    percent: raw.percent,
    error: raw.error,
    result: raw.result,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
  };
}

// ── Env Config types + helpers ──

interface EnvVar extends EvidenceFlag {
  category: string;
  sensitive: boolean;
}

const EVIDENCE_CATEGORY = 'evidence';

/** Pure: filter to evidence-category on/off toggle flags only (excludes URLs, paths, ports) */
export function filterEvidenceVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter(
    (v) => v.category === EVIDENCE_CATEGORY && !v.sensitive && (v.defaultValue === 'off' || v.defaultValue === 'on'),
  );
}

/** Pure: return evidence-category vars that are NOT toggles (URLs, paths, ports, sensitive keys) */
export function getConfigVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter((v) => v.category === EVIDENCE_CATEGORY && v.defaultValue !== 'off' && v.defaultValue !== 'on');
}
