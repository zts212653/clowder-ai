// F102: Memory domain barrel export

// Phase C: embedding + vector
export { EmbeddingService } from './EmbeddingService.js';
export type { MemoryConfig, MemoryServices } from './factory.js';
// Factory
export { createMemoryServices } from './factory.js';
export type { MessageListFn, StoredMessageSnapshot } from './IndexBuilder.js';
export { IndexBuilder } from './IndexBuilder.js';
// Interfaces + types
export type {
  ConsistencyReport,
  Edge,
  EmbedConfig,
  EmbedModelInfo,
  EvidenceItem,
  EvidenceKind,
  EvidenceStatus,
  IEmbeddingService,
  IEvidenceStore,
  IIndexBuilder,
  IKnowledgeResolver,
  IMarkerQueue,
  IMaterializationService,
  IReflectionService,
  KnowledgeResult,
  Marker,
  MarkerFilter,
  MarkerStatus,
  MaterializeResult,
  RebuildResult,
  ReflectionContext,
  SearchOptions,
} from './interfaces.js';
export {
  EVIDENCE_KINDS,
  IEmbeddingServiceSymbol,
  IEvidenceStoreSymbol,
  IIndexBuilderSymbol,
  IKnowledgeResolverSymbol,
  IMarkerQueueSymbol,
  IMaterializationServiceSymbol,
  IReflectionServiceSymbol,
  MARKER_STATUSES,
  resolveEmbedConfig,
} from './interfaces.js';
export { KnowledgeResolver } from './KnowledgeResolver.js';
export { MarkerQueue } from './MarkerQueue.js';
export { MaterializationService } from './MaterializationService.js';
export { ReflectionService } from './ReflectionService.js';
export { SemanticReranker } from './SemanticReranker.js';
// Implementations
export type { PassageResult } from './SqliteEvidenceStore.js';
export { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
export { ensureVectorTable } from './schema.js';
export { VectorStore } from './VectorStore.js';
