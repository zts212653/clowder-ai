// F263 Phase C: Memory lifecycle trace substrate types
//
// All traces are append-only and shadow — storable:false / indexable:false.
// They MUST NOT enter evidence/search/ranking pipelines.

// ── Trace kind discriminator ────────────────────────────────────────

export const LIFECYCLE_TRACE_KINDS = ['harmful_consumption', 'unmet_demand', 'verification', 'attention_cost'] as const;

export type LifecycleTraceKind = (typeof LIFECYCLE_TRACE_KINDS)[number];

// ── Harm categories (day-1: stale-pointer, identity-misbinding) ─────

export const HARM_CATEGORIES = ['stale-pointer', 'identity-misbinding'] as const;

export type HarmCategory = (typeof HARM_CATEGORIES)[number];

// ── Unmet demand buckets (C4: true-zero vs noise) ───────────────────

export const UNMET_DEMAND_BUCKETS = [
  'true_zero', // F200 observed resultCount=0 with resultStatus='no_results'
  'null_count', // resultCount was NULL (field not present)
  'not_written', // resultStatus was not written (legacy_unknown / result_unmerged)
  'parser_miss', // resultStatus='parser_miss' — parser failed to extract count
] as const;

export type UnmetDemandBucket = (typeof UNMET_DEMAND_BUCKETS)[number];

// ── Verification verdicts (C3) ──────────────────────────────────────

export const VERIFICATION_VERDICTS = [
  'confirmed', // claim verified as true
  'refuted', // claim verified as false
  'inconclusive', // verification ran but could not determine
] as const;

export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

// ── Source family — which recall surface produced this trace ─────────

export const SOURCE_FAMILIES = [
  'search_evidence',
  'graph_resolve',
  'list_recent',
  'session_bootstrap',
  'cold_context',
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

// ── Core trace type ─────────────────────────────────────────────────

export interface LifecycleTrace {
  traceId: string;
  kind: LifecycleTraceKind;
  /** Harm category (harmful_consumption) or demand bucket (unmet_demand) */
  category: string | null;
  sourceFamily: SourceFamily;
  /** FK to recall_events.recall_id — the recall event that produced this trace */
  recallId: string | null;
  /** Stable idempotency key derived from source event identity.
   * Preferred: _toolUseId (Claude API tool_use_id).
   * Fallback: invocationId:turnIndex (stable position in event array).
   * Unlike recallId, this is deterministic across retries of the same source event. */
  sourceEventId: string | null;
  /** Thread that owns this trace — used for access control scoping */
  threadId: string | null;
  /** Affected memory item anchor */
  targetAnchor: string | null;
  /** Original query text (unmet demand traces) — NOT searchable */
  queryText: string | null;
  /** Verification: what claim is being checked */
  claimKind: string | null;
  /** Verification: how the check was performed */
  checkSource: string | null;
  /** Verification: result of the check */
  verdict: VerificationVerdict | null;
  /** Flexible payload for kind-specific data */
  payload: Record<string, unknown>;
  /** When the trace was observed (epoch ms) */
  observedAt: number;
  /** When the trace was created (ISO8601) */
  createdAt: string;
}

// ── Shadow contract: these flags are always false ───────────────────
// Explicitly modeled for documentation / assertion, never stored as columns
// because the entire table is shadow by definition.

export const LIFECYCLE_TRACE_STORABLE = false as const;
export const LIFECYCLE_TRACE_INDEXABLE = false as const;

// ── Verification event projection (C3 API shape) ────────────────────

export interface VerificationEvent {
  eventId: string;
  target: string;
  claimKind: string;
  checkSource: string;
  observedAt: number;
  verdict: VerificationVerdict;
  evidence?: Record<string, unknown>;
}

// ── Three-axis dashboard types (C2) ─────────────────────────────────

export const MATURITY_LEVELS = [
  'measured', // real observation with evidence
  'estimated', // computed from partial data
  'lower-bound', // known to be an undercount
  'no-data', // no observations available
] as const;

export type MaturityLevel = (typeof MATURITY_LEVELS)[number];

export interface AxisReading {
  value: number;
  maturity: MaturityLevel;
  /** Human-readable reason when maturity is 'no-data' or 'lower-bound' */
  reason: string | null;
}

export interface ThreeAxisSnapshot {
  /** Harmful consumption count in the window */
  harmfulConsumption: AxisReading;
  /** False-negative lower bound (unmet demand true-zeros) */
  unmetDemandLowerBound: AxisReading;
  /** Attention cost: total presented items that were ignored */
  attentionCost: AxisReading;
  /** Time window in days */
  days: number;
  from: number;
  to: number;
}
