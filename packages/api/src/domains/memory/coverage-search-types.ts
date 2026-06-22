// F200 HW-1: Coverage Search Mode — types for exhaustive multi-scope search
// See docs/plans/2026-06-19-f200-hw1-coverage-search.md

import type { EvidenceDrillDown, EvidenceKind } from './interfaces.js';

// ── Match classification ────────────────────────────────────────────

export type CoverageMatchType = 'direct' | 'alias' | 'source-thread' | 'convention';
export type CoverageSource = 'docs' | 'threads' | 'convention-graph';
export type ExpansionSourceType = 'frontmatter-alias' | 'source-thread' | 'convention-edge';

// ── Expansion provenance ────────────────────────────────────────────

export interface ExpansionProvenance {
  source: ExpansionSourceType;
  /** Human-readable trace: e.g. "F200 → topic:memory" or "thread-xxx" */
  via: string;
  confidence: 'static' | 'heuristic';
}

// ── Coverage matrix output ──────────────────────────────────────────

export interface CoverageMatrixItem {
  anchor: string;
  title: string;
  kind: EvidenceKind;
  matchType: CoverageMatchType;
  /** Search match quality score */
  confidence: number;
  source: CoverageSource;
  /** Present for indirect hits; undefined for direct hits */
  expansionProvenance?: ExpansionProvenance;
  sourcePath?: string;
  drillDown?: EvidenceDrillDown;
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
