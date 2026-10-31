// F200 HW-1: Coverage Search Mode — types for exhaustive multi-scope search
// See docs/plans/2026-06-19-f200-hw1-coverage-search.md

import type { EvidenceDrillDown, EvidenceKind } from './interfaces.js';

// ── Match classification ────────────────────────────────────────────

export type CoverageMatchType = 'direct' | 'alias' | 'source-thread' | 'convention';
export type CoverageSource = 'docs' | 'threads' | 'convention-graph';
export type ExpansionSourceType = 'frontmatter-alias' | 'source-thread' | 'convention-edge';
export type CoverageRequestedScope = 'docs' | 'threads' | 'all';
export type CoverageSearchMode = 'lexical' | 'semantic' | 'hybrid';

export interface CoverageSearchRequest {
  scope?: CoverageRequestedScope;
  mode?: CoverageSearchMode;
  limit?: number;
  offset?: number;
}

// ── Expansion provenance ────────────────────────────────────────────

export interface ExpansionProvenance {
  source: ExpansionSourceType;
  /** Human-readable trace: e.g. "F200 → topic:memory" or "thread-xxx" */
  via: string;
  edgeStrength: 'static' | 'heuristic';
}

// ── Coverage matrix output ──────────────────────────────────────────

export interface CoverageMatrixItem {
  anchor: string;
  title: string;
  kind: EvidenceKind;
  matchType: CoverageMatchType;
  /** Store retrieval score; directness is expressed only by matchType. */
  retrievalScore?: number;
  source: CoverageSource;
  /** Present for indirect hits; undefined for direct hits */
  expansionProvenance?: ExpansionProvenance;
  sourcePath?: string;
  drillDown?: EvidenceDrillDown;
  /** Bounded representation used when the original item cannot fit the response budget. */
  representation?: 'oversize-placeholder';
  /** Stable non-reversible identity for an oversize source item. */
  identityDigest?: string;
  /** Explicitly explains why an oversize placeholder cannot expose a callable drill. */
  drillUnavailable?: {
    code: 'source-reference-unavailable' | 'drill-exceeds-placeholder-budget';
  };
}

export interface CoverageBySource {
  count: number;
  cap: number;
}

export interface CoverageSearchResult {
  query: string;
  totalHits: number;
  bySource: {
    docs: CoverageBySource;
    threads: CoverageBySource;
    conventionGraph: CoverageBySource;
  };
  matrix: CoverageMatrixItem[];
  gaps: string[];
  degraded?: Array<{ source: CoverageSource; reason: string }>;
  contract: {
    requested: {
      scope: CoverageRequestedScope;
      mode: CoverageSearchMode;
      limit: number;
      offset: number;
    };
    executed: {
      scopes: Array<'docs' | 'threads'>;
      mode: CoverageSearchMode;
      limit: number;
    };
    latency: {
      budgetMs: number;
      elapsedMs: number;
      timedOut: boolean;
      eventLoopLagMaxMs: number;
      abortPropagated: boolean;
    };
    response: {
      budgetChars: number;
      serializedChars: number;
      truncated: boolean;
      omittedItems: number;
      oversizeItems: number;
      hasMore: boolean;
      drillDown?: {
        tool: 'cat_cafe_search_evidence';
        params: Record<string, string>;
      };
    };
  };
}

// ── Per-source quota config ─────────────────────────────────────────

export const COVERAGE_QUOTA = {
  docs: 25,
  threads: 20,
  conventionGraph: 10,
} as const;

export const COVERAGE_MAX_TOTAL = 50;

// ── Telemetry ───────────────────────────────────────────────────────

export interface CoverageSearchEvent {
  coverageId: string;
  catId: string;
  invocationId: string;
  query: string;
  totalHits: number;
  directHits: number;
  indirectHits: number;
  bySource: Record<CoverageSource, number>;
  expansionSources: Record<ExpansionSourceType, number>;
  conventionGraphUsed: boolean;
  conventionGraphStaleSkips: number;
  matrixSize: number;
  timestamp: number;
  threadId?: string;
}

export type CoverageSearchStage =
  | 'direct-docs'
  | 'direct-threads'
  | 'frontmatter-expansion'
  | 'source-thread-expansion'
  | 'convention-expansion'
  | 'serialization';

export type CoverageSearchStageOutcome = 'ok' | 'deadline' | 'aborted' | 'error';

/** Bounded operational evidence. Query text and source identifiers are intentionally excluded. */
export interface CoverageSearchStageEvent {
  coverageId: string;
  stage: CoverageSearchStage;
  durationMs: number;
  remainingBudgetMs: number;
  eventLoopLagMs: number;
  outcome: CoverageSearchStageOutcome;
  abortPropagated: boolean;
  timestamp: number;
}
