// F102: Memory service factory — creates SQLite-backed memory services

import { EmbeddingService } from './EmbeddingService.js';
import { type ExcludeThreadIdsFn, IndexBuilder, type MessageListFn, type ThreadListFn } from './IndexBuilder.js';
import type {
  EmbedConfig,
  IEmbeddingService,
  IEvidenceStore,
  IIndexBuilder,
  IKnowledgeResolver,
  IMarkerQueue,
  IMaterializationService,
  IReflectionService,
} from './interfaces.js';
import { resolveEmbedConfig } from './interfaces.js';
import { KnowledgeResolver } from './KnowledgeResolver.js';
import { MarkerQueue } from './MarkerQueue.js';
import { MaterializationService } from './MaterializationService.js';
import { ReflectionService } from './ReflectionService.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { ensureVectorTable } from './schema.js';
import { VectorStore } from './VectorStore.js';

export interface MemoryServices {
  evidenceStore: IEvidenceStore;
  /** Phase G: direct store access for summary compaction task (getDb()) */
  store: SqliteEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
  knowledgeResolver: IKnowledgeResolver;
  indexBuilder?: IIndexBuilder;
  materializationService?: IMaterializationService;
  embeddingService?: IEmbeddingService;
  vectorStore?: VectorStore;
}

export interface MemoryConfig {
  type: 'sqlite';
  /** For sqlite: path to evidence.sqlite file */
  sqlitePath?: string;
  /** For sqlite: root docs/ directory for IndexBuilder */
  docsRoot?: string;
  /** For sqlite: markers directory (docs/markers/) */
  markersDir?: string;
  /** Phase D-6: transcript data directory for session digest indexing */
  transcriptDataDir?: string;
  /** Phase C: embedding configuration */
  embed?: Partial<EmbedConfig>;
  /** Phase E-1: callback that returns all threads for summary indexing */
  threadListFn?: ThreadListFn;
  /** Phase E-3: callback that returns messages for a given thread (passage indexing) */
  messageListFn?: MessageListFn;
  /** Callback returning thread IDs to exclude from session digest indexing (e.g. game threads) */
  excludeThreadIdsFn?: ExcludeThreadIdsFn;
}

export async function createMemoryServices(config: MemoryConfig): Promise<MemoryServices> {
  const sqlitePath = config.sqlitePath ?? 'evidence.sqlite';
  const docsRoot = config.docsRoot ?? 'docs';
  const markersDir = config.markersDir ?? 'docs/markers';
  const embedConfig = resolveEmbedConfig(config.embed);

  const store = new SqliteEvidenceStore(sqlitePath);
  await store.initialize();

  let embeddingService: IEmbeddingService | undefined;
  let vectorStore: VectorStore | undefined;

  if (embedConfig.embedMode !== 'off') {
    embeddingService = new EmbeddingService(embedConfig);

    // P1 (codex R2): explicitly call load() — without this, isReady() stays false forever.
    // Wrapped in try-catch for AC-C4 fail-open.
    try {
      await embeddingService.load();
    } catch {
      // fail-open: model load failed → isReady()=false → lexical-only degradation
    }

    // Load sqlite-vec + ensure vec0 table (decoupled from migration, fail-open)
    try {
      const sqliteVecMod = await import('sqlite-vec');
      sqliteVecMod.load(store.getDb());
      const ok = ensureVectorTable(store.getDb(), embedConfig.embedDim);
      if (ok) {
        vectorStore = new VectorStore(store.getDb(), embedConfig.embedDim);
      }
    } catch {
      // fail-open: sqlite-vec not available
    }
  }

  const embedDeps = embeddingService && vectorStore ? { embedding: embeddingService, vectorStore } : undefined;
  const indexBuilder = new IndexBuilder(
    store,
    docsRoot,
    embedDeps,
    config.transcriptDataDir,
    config.threadListFn,
    config.messageListFn,
    config.excludeThreadIdsFn,
  );

  // Wire rerank deps into store for search-time
  if (embedDeps) {
    store.setEmbedDeps({ ...embedDeps, mode: embedConfig.embedMode as 'shadow' | 'on' });
  }

  const markerQueue = new MarkerQueue(markersDir);
  const materializationService = new MaterializationService(markerQueue, docsRoot);
  const reflectionService = new ReflectionService(
    async () => '[reflect not configured — use search_evidence to find project knowledge]',
  );
  const knowledgeResolver = new KnowledgeResolver({ projectStore: store });

  return {
    evidenceStore: store,
    store,
    markerQueue,
    reflectionService,
    knowledgeResolver,
    indexBuilder,
    materializationService,
    embeddingService,
    vectorStore,
  };
}
