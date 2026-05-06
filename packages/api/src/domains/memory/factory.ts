// F102: Memory service factory — creates SQLite-backed memory services

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EmbeddingService } from './EmbeddingService.js';
import { loadExternalCollections, resolveCollectionStorePath } from './external-collections.js';
import { GlobalIndexBuilder } from './GlobalIndexBuilder.js';
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
import { LibraryCatalog } from './LibraryCatalog.js';
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
  /** F-4: Global knowledge index builder (Skills + MEMORY.md) */
  globalIndexBuilder?: GlobalIndexBuilder;
  /** F152 Phase C: Global knowledge store for distillation */
  globalStore?: SqliteEvidenceStore;
  /** F186 Phase A: Collection registry */
  catalog?: LibraryCatalog;
  /** F186 Phase D: All collection stores (built-in + external) */
  collectionStores?: Map<string, IEvidenceStore>;
  /** F186 Phase D: Data directory for external collection persistence */
  dataDir?: string;
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
  /** F-4: path to global knowledge SQLite (default: ~/.cat-cafe/global_knowledge.sqlite) */
  globalDbPath?: string;
  /** F-4: Skills root directory (default: ~/.claude/skills/) */
  skillsRoot?: string;
  /** F-4: Claude projects memory root (default: ~/.claude/projects/) */
  memoryRoot?: string;
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
  const materializationService = new MaterializationService(markerQueue, docsRoot, indexBuilder);
  const reflectionService = new ReflectionService(
    async () => '[reflect not configured — use search_evidence to find project knowledge]',
  );

  // F-4: Global knowledge store (optional — fail-open if missing/broken)
  let globalStore: SqliteEvidenceStore | undefined;
  let globalIndexBuilder: GlobalIndexBuilder | undefined;
  const globalPath =
    config.globalDbPath ??
    process.env['GLOBAL_KNOWLEDGE_DB'] ??
    join(homedir(), '.cat-cafe', 'global_knowledge.sqlite');
  try {
    mkdirSync(dirname(globalPath), { recursive: true });
    globalStore = new SqliteEvidenceStore(globalPath);
    await globalStore.initialize();
    globalIndexBuilder = new GlobalIndexBuilder({
      skillsRoot: config.skillsRoot ?? join(homedir(), '.claude', 'skills'),
      memoryRoot: config.memoryRoot ?? join(homedir(), '.claude', 'projects'),
      globalStore,
    });
  } catch {
    // fail-open: no global knowledge → project-only search
  }

  const catalog = new LibraryCatalog();
  const stores = new Map<string, IEvidenceStore>();
  const now = new Date().toISOString();

  catalog.register({
    id: 'project:cat-cafe',
    kind: 'project',
    name: 'cat-cafe',
    displayName: 'Clowder AI Project',
    root: docsRoot,
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: now,
    updatedAt: now,
  });
  stores.set('project:cat-cafe', store);

  if (globalStore) {
    catalog.register({
      id: 'global:methods',
      kind: 'global',
      name: 'methods',
      displayName: 'Global Methods',
      root: dirname(globalPath),
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: now,
      updatedAt: now,
    });
    stores.set('global:methods', globalStore);
  }

  const dataDir = join(homedir(), '.cat-cafe');
  const externals = loadExternalCollections(dataDir);
  for (const manifest of externals) {
    try {
      catalog.register(manifest);
      const storePath = resolveCollectionStorePath(dataDir, manifest.id);
      mkdirSync(dirname(storePath), { recursive: true });
      const extStore = new SqliteEvidenceStore(storePath);
      await extStore.initialize();
      stores.set(manifest.id, extStore);
    } catch {
      // fail-open: skip broken external collections
    }
  }

  const knowledgeResolver = new KnowledgeResolver({ projectStore: store, globalStore, catalog, stores });

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
    globalIndexBuilder,
    globalStore,
    catalog,
    collectionStores: stores,
    dataDir,
  };
}
