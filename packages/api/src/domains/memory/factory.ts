// F102: Memory service factory — creates the right implementations based on config

import type { IHindsightClient } from '../cats/services/orchestration/HindsightClient.js';
import { EmbeddingService } from './EmbeddingService.js';
import { HindsightAdapter } from './HindsightAdapter.js';
import { IndexBuilder } from './IndexBuilder.js';
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
import { createHindsightReflectBackend, ReflectionService } from './ReflectionService.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { ensureVectorTable } from './schema.js';
import { VectorStore } from './VectorStore.js';

export interface MemoryServices {
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
  knowledgeResolver: IKnowledgeResolver;
  indexBuilder?: IIndexBuilder;
  materializationService?: IMaterializationService;
  embeddingService?: IEmbeddingService;
  vectorStore?: VectorStore;
}

export interface MemoryConfig {
  type: 'sqlite' | 'hindsight';
  /** For sqlite: path to evidence.sqlite file */
  sqlitePath?: string;
  /** For sqlite: root docs/ directory for IndexBuilder */
  docsRoot?: string;
  /** For sqlite: markers directory (docs/markers/) */
  markersDir?: string;
  /** For hindsight: the IHindsightClient instance */
  hindsightClient?: IHindsightClient;
  /** For hindsight: bank ID */
  hindsightBank?: string;
  /** Phase C: embedding configuration */
  embed?: Partial<EmbedConfig>;
}

export async function createMemoryServices(config: MemoryConfig): Promise<MemoryServices> {
  if (config.type === 'sqlite') {
    return createSqliteServices(config);
  }
  return createHindsightServices(config);
}

async function createSqliteServices(config: MemoryConfig): Promise<MemoryServices> {
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
      // @ts-ignore — optional dep, may or may not be installed
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
  const indexBuilder = new IndexBuilder(store, docsRoot, embedDeps);

  // Wire rerank deps into store for search-time
  if (embedDeps) {
    store.setEmbedDeps({ ...embedDeps, mode: embedConfig.embedMode as 'shadow' | 'on' });
  }

  const markerQueue = new MarkerQueue(markersDir);
  const materializationService = new MaterializationService(markerQueue, docsRoot);
  const reflectionService = new ReflectionService(async () => '');
  const knowledgeResolver = new KnowledgeResolver({ projectStore: store });

  return {
    evidenceStore: store,
    markerQueue,
    reflectionService,
    knowledgeResolver,
    indexBuilder,
    materializationService,
    embeddingService,
    vectorStore,
  };
}

async function createHindsightServices(config: MemoryConfig): Promise<MemoryServices> {
  const client = config.hindsightClient;
  const bankId = config.hindsightBank ?? 'cat-cafe-shared';
  if (!client) throw new Error('hindsightClient required for type=hindsight');

  const adapter = new HindsightAdapter(client, bankId);
  await adapter.initialize();

  const markersDir = config.markersDir ?? 'docs/markers';
  const markerQueue = new MarkerQueue(markersDir);
  const reflectionService = new ReflectionService(createHindsightReflectBackend(client, bankId));
  const knowledgeResolver = new KnowledgeResolver({ projectStore: adapter });

  return {
    evidenceStore: adapter,
    markerQueue,
    reflectionService,
    knowledgeResolver,
  };
}
