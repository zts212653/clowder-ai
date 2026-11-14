import type { ExpansionHintTargetRef } from '@cat-cafe/shared';
import type { ExpansionProvenance } from './coverage-search-types.js';
// ── Output types ─────────────────────────────────────────────────────

export interface ExpansionHint {
  anchor: string;
  title: string;
  kind: string;
  sourcePath?: string;
  targetRef: ExpansionHintTargetRef;
  provenance: ExpansionProvenance;
}

export interface TopkExpansionOptions {
  /** Max number of top results to expand (default 3) */
  maxHitsToExpand?: number;
  /** Max hints per expansion type (default 3) */
  maxHintsPerType?: number;
}

// ── F256 health funnel: per-stage telemetry ─────────────────────────

export interface ExpansionSourceFunnel {
  probed: number;
  added: number;
  deduped: number;
}

export interface ExpansionConventionEdgeFunnel {
  attempted: boolean;
  added: number;
  deduped: number;
  staleSkipped: number;
}

export interface ExpansionFunnel {
  attempted: boolean;
  keyword: ExpansionSourceFunnel;
  sourceThread: ExpansionSourceFunnel;
  conventionEdge: ExpansionConventionEdgeFunnel;
  presented: number;
}

export interface ExpandWithMetaResult {
  hints: ExpansionHint[];
  funnel: ExpansionFunnel;
}
