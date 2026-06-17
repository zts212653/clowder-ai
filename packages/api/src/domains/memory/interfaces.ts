// F102: Memory component interfaces — 6 pluggable adapters
// See docs/features/F102-memory-adapter-refactor.md for architecture

import type { CollectionSensitivity, ReviewStatus, SearchDimension } from './collection-types.js';
import type { F163Activation, F163Authority } from './f163-types.js';

export * from './collection-types.js';

// ── Runtime guard symbols (TypeScript interfaces erase at runtime) ────

export const IEvidenceStoreSymbol = Symbol.for('IEvidenceStore');
export const IIndexBuilderSymbol = Symbol.for('IIndexBuilder');
export const IMarkerQueueSymbol = Symbol.for('IMarkerQueue');
export const IMaterializationServiceSymbol = Symbol.for('IMaterializationService');
export const IReflectionServiceSymbol = Symbol.for('IReflectionService');
export const IKnowledgeResolverSymbol = Symbol.for('IKnowledgeResolver');
export const IEmbeddingServiceSymbol = Symbol.for('IEmbeddingService');

// ── Value enums ──────────────────────────────────────────────────────

export const MARKER_STATUSES = [
  'captured',
  'normalized',
  'approved',
  'rejected',
  'needs_review',
  'materialized',
  'indexed',
] as const;

export type MarkerStatus = (typeof MARKER_STATUSES)[number];

export const EVIDENCE_KINDS = [
  'feature',
  'decision',
  'plan',
  'session',
  'lesson',
  'thread',
  'discussion',
  'research',
  'pack-knowledge',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceStatus = 'active' | 'done' | 'archived' | 'review' | 'invalidated';

// ── F152 Phase A: Provenance + Scanner types ────────────────────────

export type ProvenanceTier = 'authoritative' | 'derived' | 'soft_clue';

export interface Provenance {
  tier: ProvenanceTier;
  source: string;
}

export interface ScannedEvidence {
  item: Omit<EvidenceItem, 'sourceHash'>;
  provenance: Provenance;
  rawContent: string;
}

export interface RepoScanner {
  discover(projectRoot: string, options?: Record<string, unknown>): ScannedEvidence[];
}

export const IRepoScannerSymbol = Symbol.for('IRepoScanner');

// ── Data types ───────────────────────────────────────────────────────

export interface EvidenceDrillDown {
  tool: string;
  params: Record<string, string>;
  hint: string;
}

export interface EvidenceItem {
  anchor: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  title: string;
  summary?: string;
  keywords?: string[];
  sourcePath?: string;
  sourceHash?: string;
  supersededBy?: string;
  materializedFrom?: string;
  updatedAt: string;
  /** F129: Pack scope — when set, this evidence belongs to a specific pack */
  packId?: string;
  /** G-4: drill-down hint — tells the cat what tool to use to see full details */
  drillDown?: EvidenceDrillDown;
  /** F163 Phase A: knowledge authority level */
  authority?: F163Authority;
  /** F163 Phase A: knowledge activation mode */
  activation?: F163Activation;
  /** F163 Phase A: last verification date (ISO8601) */
  verifiedAt?: string;
  /** F152 Phase A: provenance tracking for scanner-produced evidence */
  provenance?: Provenance;
  /** F152 Phase C: null = unmarked, false = project-private, true = candidate for global reflow */
  generalizable?: boolean;
  /** F163 Phase B: JSON array of source anchors this summary covers */
  sourceIds?: string[];
  /** F163 Phase B: summary group ID — non-null means this doc IS a canonical summary */
  summaryOfAnchor?: string;
  /** F163 Phase B: why these sources were merged */
  compressionRationale?: string;
  /** F163 Phase C: JSON array of anchor IDs this item contradicts */
  contradicts?: string[];
  /** F163 Phase C: when contradiction/invalidity was detected (ISO8601) */
  invalidAt?: string;
  /** F163 Phase C: days between review cycles */
  reviewCycleDays?: number;
  /** F093 Phase A (KD-16): world scope — derived canon evidence */
  worldId?: string;
  /** F093 Phase A (KD-16): scene scope — derived canon evidence */
  sceneId?: string;
  /** F200 Phase C: first indexed timestamp (epoch ms) for 14d grace period */
  firstIndexedAt?: number;
  /** F186: collection-level review status */
  reviewStatus?: ReviewStatus;
  /** F200 v1.1 DF-3: explains why this result matched (anchor/title/summary/keyword/content) */
  matchReason?: string;
  /** F200 v1.1 DF-3: ranking factor breakdown when explain=true */
  rankingFactors?: { bm25Score?: number; consumptionPrior?: number; mmrPenalty?: number };
  /** F200 v1.1 DF-7: calibrated relevance confidence [0,1] */
  confidence?: number;
  /** F209 Phase B: entity alias / mention explanations for retrieval-anchor hits */
  entityMatches?: EntityMatch[];
  /** AC-I9: passage-level detail when depth=raw */
  passages?: Array<{
    docAnchor?: string;
    passageId: string;
    content: string;
    speaker?: string;
    createdAt?: string;
    threadId?: string;
    messageId?: string;
    /** AC-I8: surrounding passages when contextWindow is set */
    context?: Array<{
      docAnchor?: string;
      passageId: string;
      content: string;
      speaker?: string;
      createdAt?: string;
      threadId?: string;
      messageId?: string;
    }>;
  }>;
}

export type EntityType = 'person' | 'cat' | 'feature' | 'concept' | 'external';

export interface EntityProvenance {
  source: string;
  anchor?: string;
  note?: string;
  date?: string;
}

export interface EntityRecord {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  provenance: EntityProvenance[];
  createdAt?: string;
  updatedAt: string;
}

export interface QueryEntityMatch {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  matchedAlias: string;
  provenance: EntityProvenance[];
}

export interface EntityMatch {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  matchedAlias: string;
  surface: string;
  source: 'doc' | 'passage';
  docAnchor: string;
  passageId?: string;
  provenance: EntityProvenance[];
  why: string;
}

export type EdgeRelation =
  | 'evolved_from'
  | 'blocked_by'
  | 'related'
  | 'related_to'
  | 'supersedes'
  | 'invalidates'
  | 'promoted_from'
  | 'wikilink'
  | 'doc_link'
  | 'feature_ref';

export interface Edge {
  fromAnchor: string;
  toAnchor: string;
  relation: EdgeRelation;
  fromCollectionId?: string;
  toCollectionId?: string;
  edgeSensitivity?: CollectionSensitivity;
  provenance?: 'frontmatter' | 'wikilink' | 'promote' | 'manual' | 'content';
  createdAt?: string;
}

export interface Marker {
  id: string;
  content: string;
  source: string;
  status: MarkerStatus;
  targetKind?: EvidenceKind;
  createdAt: string;
  sourceCollectionId?: string;
  sourceSensitivity?: CollectionSensitivity;
  targetCollectionId?: string;
  promoteReviewStatus?: ReviewStatus;
  secretScanFingerprint?: string;
}

export interface SearchOptions {
  kind?: EvidenceKind;
  status?: EvidenceStatus;
  keywords?: string[];
  limit?: number;
  /** Phase D: collection scope — which data layer to search */
  scope?: 'docs' | 'memory' | 'threads' | 'sessions' | 'all';
  /** Phase D: retrieval mode */
  mode?: 'lexical' | 'semantic' | 'hybrid';
  /** Phase D: result depth — summary (default) or raw detail */
  depth?: 'summary' | 'raw';
  /** Phase I (AC-I4): ISO8601 date filter, inclusive lower bound */
  dateFrom?: string;
  /** Phase I (AC-I4): ISO8601 date filter, inclusive upper bound */
  dateTo?: string;
  /** Phase I (AC-I8): number of surrounding passages to include per match */
  contextWindow?: number;
  /** F148 Phase B (AC-B1): filter evidence to a specific thread's digest */
  threadId?: string;
  /** F102 Batch 3: knowledge dimension — project, global, or all (default); F186: library | collection */
  dimension?: SearchDimension;
  /** F186: filter to specific collection IDs when dimension=collection */
  collections?: string[];
  /** F152 Phase A (AC-A6): filter by provenance tier */
  provenanceTier?: ProvenanceTier;
  /** F163 Phase B (AC-B3): include backstop docs in results (for drill-down) */
  includeBackstop?: boolean;
  /** F093 Phase A (KD-16): filter to a specific world's derived knowledge */
  worldId?: string;
  /** F093 Phase A (KD-16): filter to a specific scene within a world */
  sceneId?: string;
  /** F200 v1.1 DF-3: include explainability fields in results */
  explain?: boolean;
}

export type SearchDegradeReason =
  | 'passage_embedding_unavailable'
  | 'passage_vector_search_error'
  | 'evidence_store_error'
  | 'raw_lexical_only';

export interface SearchExecutionMeta {
  degraded: boolean;
  degradeReason?: SearchDegradeReason;
  effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
}

export interface EvidenceSearchExecution {
  items: EvidenceItem[];
  meta: SearchExecutionMeta;
}

export interface MarkerFilter {
  status?: MarkerStatus;
  targetKind?: EvidenceKind;
  source?: string;
}

// ── Result types ─────────────────────────────────────────────────────

export interface RebuildResult {
  docsIndexed: number;
  docsSkipped: number;
  durationMs: number;
}

export interface ConsistencyReport {
  ok: boolean;
  docCount: number;
  ftsCount: number;
  mismatches: string[];
}

export interface MaterializeResult {
  markerId: string;
  outputPath: string;
  anchor: string;
  committed: boolean;
  reindexed: boolean;
}

export interface CollectionGroup {
  collectionId: string;
  sensitivity: CollectionSensitivity;
  status: 'ok' | 'timeout' | 'skipped' | 'error';
  whyIncluded?: string;
  durationMs: number;
  items: EvidenceItem[];
}

export interface KnowledgeResult {
  results: EvidenceItem[];
  sources: Array<'project' | 'global'>;
  query: string;
  meta?: SearchExecutionMeta;
  collectionGroups?: CollectionGroup[];
  deprecationWarnings?: string[];
}

export interface ReflectionContext {
  threadId?: string;
  catId?: string;
  recentMessages?: string[];
}

// ── Interfaces ───────────────────────────────────────────────────────

export interface IEvidenceStore {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
  searchWithMeta?(query: string, options?: SearchOptions): Promise<EvidenceSearchExecution>;
  upsert(items: EvidenceItem[]): Promise<void>;
  upsertEntities?(entities: EntityRecord[]): Promise<void>;
  getEntity?(entityId: string): Promise<EntityRecord | null>;
  resolveEntityAliases?(query: string): Promise<QueryEntityMatch[]>;
  refreshEntityMentions?(docAnchors?: string[]): Promise<void>;
  deleteByAnchor(anchor: string): Promise<void>;
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  health(): Promise<boolean>;
  initialize(): Promise<void>;
}

export type RebuildProgressCallback = (phase: string, percent: number) => void;

export interface IIndexBuilder {
  rebuild(options?: { force?: boolean; onProgress?: RebuildProgressCallback }): Promise<RebuildResult>;
  startPassageEmbeddingWarmup(): void;
  incrementalUpdate(changedPaths: string[]): Promise<void>;
  checkConsistency(): Promise<ConsistencyReport>;
}

export interface IMarkerQueue {
  submit(marker: Omit<Marker, 'id' | 'createdAt'>): Promise<Marker>;
  list(filter?: MarkerFilter): Promise<Marker[]>;
  transition(id: string, to: MarkerStatus, patch?: Partial<Marker>): Promise<void>;
}

export interface MaterializeOptions {
  targetRoot?: string;
  indexBuilder?: Pick<IIndexBuilder, 'incrementalUpdate'> | null;
  /**
   * Opt-in: git-commit the materialized .md (default off). Auto-committing onto
   * the current branch (e.g. runtime/main-sync) silently diverges it and breaks
   * the next ff-only sync — callers that want git persistence must opt in explicitly.
   */
  commit?: boolean;
}

export interface IMaterializationService {
  materialize(markerId: string, options?: MaterializeOptions): Promise<MaterializeResult>;
  canMaterialize(markerId: string): Promise<boolean>;
}

export interface IReflectionService {
  reflect(query: string, context?: ReflectionContext): Promise<string>;
}

export interface IKnowledgeResolver {
  resolve(query: string, options?: SearchOptions): Promise<KnowledgeResult>;
}

// ── Phase C: Embedding / Vector types ─────────────────────────────

export interface EmbedConfig {
  embedMode: 'off' | 'shadow' | 'on';
  embedModel: string;
  embedDim: number;
  maxModelMemMb: number;
  embedTimeoutMs: number;
}

export interface EmbedModelInfo {
  modelId: string;
  modelRev: string;
  dim: number;
}

export interface IEmbeddingService {
  load(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  isReady(): boolean;
  reprobeIfNeeded(): Promise<void>;
  getModelInfo(): EmbedModelInfo;
  dispose(): void;
}

const VALID_EMBED_MODES = new Set(['off', 'shadow', 'on']);

export function resolveEmbedConfig(partial?: Partial<EmbedConfig>): EmbedConfig {
  const mode = partial?.embedMode ?? 'off';
  if (!VALID_EMBED_MODES.has(mode)) throw new Error(`Invalid embedMode: ${mode}`);
  // The scripted sidecar is the runtime authority for the concrete model
  // after /health responds. Until then this sentinel keeps local config free
  // of stale TypeScript-side model whitelists.
  const model = partial?.embedModel ?? 'unknown';
  return {
    embedMode: mode as EmbedConfig['embedMode'],
    embedModel: model,
    embedDim: partial?.embedDim ?? 768, // LL-034: 768 is sweet spot for CJK bilingual; 256 too low
    maxModelMemMb: partial?.maxModelMemMb ?? 800,
    embedTimeoutMs: partial?.embedTimeoutMs ?? 3000,
  };
}
