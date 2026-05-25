import type { SearchDimension } from './collection-types.js';
import type { EvidenceDrillDown, SearchExecutionMeta } from './interfaces.js';

export type PerspectiveSearchScope = 'docs' | 'memory' | 'threads' | 'sessions' | 'all';
export type PerspectiveSearchMode = 'lexical' | 'semantic' | 'hybrid';
export type PerspectiveSearchDepth = 'summary' | 'raw';

export type PerspectiveScalar = string | number | boolean;

export interface PerspectiveInputSpec {
  description: string;
  required?: boolean;
  default?: PerspectiveScalar;
}

export interface PerspectiveSearchEvidenceStep {
  id: string;
  type: 'search_evidence';
  query: string;
  scope?: PerspectiveSearchScope;
  mode?: PerspectiveSearchMode;
  depth?: PerspectiveSearchDepth;
  limit?: number;
  dimension?: SearchDimension;
  collections?: string[];
  explain?: boolean;
}

export interface PerspectiveGraphResolveStep {
  id: string;
  type: 'graph_resolve';
  anchor: string;
}

export interface PerspectiveOpenAnchorStep {
  id: string;
  type: 'open_anchor';
  source: 'previous_step';
  selector: 'top';
  maxOpen: number;
}

export type PerspectiveStep = PerspectiveSearchEvidenceStep | PerspectiveGraphResolveStep | PerspectiveOpenAnchorStep;

export interface PerspectiveOutputPolicy {
  storesResults: false;
  returnsConclusion: false;
  requiresAnchors: true;
}

export interface PerspectivePlan {
  schemaVersion: 1;
  id: string;
  title: string;
  featureIds: string[];
  ownerCatId: string;
  intent: string;
  inputs?: Record<string, PerspectiveInputSpec>;
  defaults?: Record<string, PerspectiveScalar>;
  steps: PerspectiveStep[];
  outputPolicy: PerspectiveOutputPolicy;
}

export interface LoadedPerspectivePlan {
  plan: PerspectivePlan;
  relativePath: string;
  absolutePath: string;
  body: string;
}

export interface PerspectiveAnchorCandidate {
  anchor: string;
  title: string;
  summary?: string;
  sourcePath?: string;
  drillDown?: EvidenceDrillDown;
  sourceStepId: string;
  rank: number;
}

export interface PerspectiveOpenedAnchor {
  anchor: string;
  status: 'route_identified' | 'opened' | 'unsupported' | 'error';
  sourceStepId?: string;
  stepId?: string;
  tool?: string;
  content?: string;
  error?: string;
}

export interface PerspectiveWarning {
  stepId: string;
  code: string;
  message: string;
}

export interface PerspectiveRunStep {
  id: string;
  type: PerspectiveStep['type'];
  status: 'ok' | 'warning' | 'error';
  startedAt: string;
  finishedAt: string;
  queryOrAnchor?: string;
  hitCount?: number;
  openedCount?: number;
  degraded?: SearchExecutionMeta['degraded'];
  degradeReason?: SearchExecutionMeta['degradeReason'];
  effectiveMode?: SearchExecutionMeta['effectiveMode'];
}

export interface PerspectiveRun {
  runId: string;
  planId: string;
  startedAt: string;
  actorCatId: string;
  effectiveInputs: Record<string, unknown>;
  steps: PerspectiveRunStep[];
  candidateAnchors: PerspectiveAnchorCandidate[];
  openedAnchors: PerspectiveOpenedAnchor[];
  warnings: PerspectiveWarning[];
}
