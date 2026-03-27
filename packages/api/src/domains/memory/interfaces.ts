// F102: Memory component interfaces — 6 pluggable adapters
// See docs/features/F102-memory-adapter-refactor.md for architecture

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

export type EvidenceStatus = 'active' | 'done' | 'archived';

// ── Data types ───────────────────────────────────────────────────────

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
  drillDown?: {
    tool: string;
    params: Record<string, string>;
    hint: string;
  };
}

export interface Edge {
  fromAnchor: string;
  toAnchor: string;
  relation: 'evolved_from' | 'blocked_by' | 'related' | 'supersedes' | 'invalidates';
}

export interface Marker {
  id: string;
  content: string;
  source: string;
  status: MarkerStatus;
  targetKind?: EvidenceKind;
  createdAt: string;
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
}

export interface KnowledgeResult {
  results: EvidenceItem[];
  sources: Array<'project' | 'global'>;
  query: string;
}

export interface ReflectionContext {
  threadId?: string;
  catId?: string;
  recentMessages?: string[];
}

// ── Interfaces ───────────────────────────────────────────────────────

export interface IEvidenceStore {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
  upsert(items: EvidenceItem[]): Promise<void>;
  deleteByAnchor(anchor: string): Promise<void>;
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  health(): Promise<boolean>;
  initialize(): Promise<void>;
}

export interface IIndexBuilder {
  rebuild(options?: { force?: boolean }): Promise<RebuildResult>;
  incrementalUpdate(changedPaths: string[]): Promise<void>;
  checkConsistency(): Promise<ConsistencyReport>;
}

export interface IMarkerQueue {
  submit(marker: Omit<Marker, 'id' | 'createdAt'>): Promise<Marker>;
  list(filter?: MarkerFilter): Promise<Marker[]>;
  transition(id: string, to: MarkerStatus): Promise<void>;
}

export interface IMaterializationService {
  materialize(markerId: string): Promise<MaterializeResult>;
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
  embedModel: 'qwen3-embedding-0.6b' | 'multilingual-e5-small';
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
  getModelInfo(): EmbedModelInfo;
  dispose(): void;
}

const VALID_EMBED_MODES = new Set(['off', 'shadow', 'on']);
const VALID_EMBED_MODELS = new Set(['qwen3-embedding-0.6b', 'multilingual-e5-small']);

export function resolveEmbedConfig(partial?: Partial<EmbedConfig>): EmbedConfig {
  const mode = partial?.embedMode ?? 'off';
  if (!VALID_EMBED_MODES.has(mode)) throw new Error(`Invalid embedMode: ${mode}`);
  const model = partial?.embedModel ?? 'qwen3-embedding-0.6b';
  if (!VALID_EMBED_MODELS.has(model)) throw new Error(`Invalid embedModel: ${model}`);
  return {
    embedMode: mode as EmbedConfig['embedMode'],
    embedModel: model as EmbedConfig['embedModel'],
    embedDim: partial?.embedDim ?? 768, // LL-034: 768 is sweet spot for CJK bilingual; 256 too low
    maxModelMemMb: partial?.maxModelMemMb ?? 800,
    embedTimeoutMs: partial?.embedTimeoutMs ?? 3000,
  };
}
