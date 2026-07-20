// F102: Memory service factory — creates SQLite-backed memory services

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { IEventMemoryStore } from './EventMemoryStore.js';
import { EventMemoryStore } from './EventMemoryStore.js';
import { loadEntitySeeds } from './entity-seeds.js';
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
import { MemoryEmbeddingLifecycle } from './MemoryEmbeddingLifecycle.js';
import type { PassageVectorStore } from './PassageVectorStore.js';
import { ReflectionService } from './ReflectionService.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import type { VectorStore } from './VectorStore.js';

export interface MemoryServices {
  evidenceStore: IEvidenceStore;
  /** Phase G: direct store access for summary compaction task (getDb()) */
  store: SqliteEvidenceStore;
  /** F227: typed event index (magic-word / cognitive-transition events). */
  eventMemoryStore: IEventMemoryStore;
  /** Resolved runtime event-memory DB path (trusted config, may be absolute). */
  eventMemoryDbPath: string;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
  knowledgeResolver: IKnowledgeResolver;
  indexBuilder?: IIndexBuilder;
  materializationService?: IMaterializationService;
  embeddingLifecycle: MemoryEmbeddingLifecycle;
  embeddingService?: IEmbeddingService;
  vectorStore?: VectorStore;
  passageVectorStore?: PassageVectorStore;
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
  /** F186: External collection data directory (default: ~/.cat-cafe) */
  dataDir?: string;
  /** F209 Phase B.1: explicit entity seed file (default: config/entity-seeds.json). */
  entitySeedPath?: string;
  /** F209 Phase B.1: one-way F032 roster → entity registry mirror (default: true). */
  includeRosterEntitySeeds?: boolean;
}

export function computeChildExcludes(parentRoot: string, children: Array<{ root: string }>): string[] {
  const absParent = resolve(parentRoot);
  const excludes: string[] = [];
  for (const child of children) {
    const absChild = resolve(child.root);
    if (absChild.startsWith(absParent + '/') && absChild !== absParent) {
      const rel = relative(absParent, absChild);
      excludes.push(`${rel}/**`);
    }
  }
  return excludes;
}

/**
 * F227: build the typed Event Memory store. Separated from createMemoryServices to
 * keep that factory's cognitive complexity bounded. :memory: passes through (tests).
 */
function resolveEventMemoryDbPath(config: MemoryConfig, sqlitePath: string): string {
  return (
    process.env.EVENT_MEMORY_DB ??
    (config.sqlitePath === ':memory:' ? ':memory:' : join(dirname(resolve(sqlitePath)), 'event-memory.sqlite'))
  );
}

async function buildEventMemoryStore(config: MemoryConfig, sqlitePath: string): Promise<EventMemoryStore> {
  const path = resolveEventMemoryDbPath(config, sqlitePath);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const store = new EventMemoryStore(path);
  await store.initialize();
  return store;
}

export async function createMemoryServices(config: MemoryConfig): Promise<MemoryServices> {
  const sqlitePath = config.sqlitePath ?? 'evidence.sqlite';
  const docsRoot = config.docsRoot ?? 'docs';
  const markersDir = config.markersDir ?? 'docs/markers';
  const embedConfig = resolveEmbedConfig(config.embed);

  const store = new SqliteEvidenceStore(sqlitePath);
  await store.initialize();
  const stores = new Map<string, IEvidenceStore>();
  stores.set('project:cat-cafe', store);
  const entitySeeds = loadEntitySeeds({
    explicitSeedPath: config.entitySeedPath,
    includeRoster: config.includeRosterEntitySeeds,
  });
  if (entitySeeds.length > 0) {
    await store.upsertEntities(entitySeeds);
  }

  // Pre-load external manifests to compute child excludes (AC-H1)
  // Must happen before IndexBuilder so CatCafeScanner gets the exclude patterns
  const dataDir = config.dataDir ?? join(homedir(), '.cat-cafe');
  const externals = loadExternalCollections(dataDir);
  const childExcludes = computeChildExcludes(docsRoot, externals);

  const indexBuilder = new IndexBuilder(
    store,
    docsRoot,
    undefined,
    config.transcriptDataDir,
    config.threadListFn,
    config.messageListFn,
    config.excludeThreadIdsFn,
    undefined,
    childExcludes.length > 0 ? childExcludes : undefined,
  );
  const embeddingLifecycle = new MemoryEmbeddingLifecycle(store, indexBuilder, embedConfig, {
    getDependentStores: () =>
      [...stores.values()].filter(
        (candidate): candidate is SqliteEvidenceStore => candidate instanceof SqliteEvidenceStore,
      ),
  });
  if (embedConfig.embedMode !== 'off') {
    await embeddingLifecycle.activate(embedConfig.embedMode);
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
  const now = new Date().toISOString();

  catalog.register({
    id: 'project:cat-cafe',
    kind: 'project',
    name: 'cat-cafe',
    displayName: 'Clowder AI Project',
    root: docsRoot,
    sensitivity: 'internal',
    scannerLevel: 0,
    exclude: childExcludes.length > 0 ? childExcludes : undefined,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: now,
    updatedAt: now,
  });
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
  for (const manifest of externals) {
    try {
      catalog.register(manifest);
      if (manifest.status === 'archived') continue;
      const storePath = resolveCollectionStorePath(dataDir, manifest.id);
      mkdirSync(dirname(storePath), { recursive: true });
      const extStore = new SqliteEvidenceStore(storePath, undefined, {
        sourceRoot: manifest.root,
        sourceRef: manifest.id,
      });
      await extStore.initialize();
      stores.set(manifest.id, extStore);
    } catch {
      // fail-open: skip broken external collections
    }
  }

  const knowledgeResolver = new KnowledgeResolver({ projectStore: store, globalStore, catalog, stores });

  // F227: typed Event Memory store (magic-word truth source, LL-048 fail-loud).
  const eventMemoryStore = await buildEventMemoryStore(config, sqlitePath);
  const eventMemoryDbPath = resolveEventMemoryDbPath(config, sqlitePath);

  return {
    evidenceStore: store,
    store,
    eventMemoryStore,
    eventMemoryDbPath,
    markerQueue,
    reflectionService,
    knowledgeResolver,
    indexBuilder,
    materializationService,
    embeddingLifecycle,
    get embeddingService(): IEmbeddingService | undefined {
      return embeddingLifecycle.getService();
    },
    get vectorStore(): VectorStore | undefined {
      return embeddingLifecycle.getVectorStore();
    },
    get passageVectorStore(): PassageVectorStore | undefined {
      return embeddingLifecycle.getPassageVectorStore();
    },
    globalIndexBuilder,
    globalStore,
    catalog,
    collectionStores: stores,
    dataDir,
  };
}
