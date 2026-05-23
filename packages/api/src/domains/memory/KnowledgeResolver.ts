// F102+F186: IKnowledgeResolver — federated search across N collections
// F102 Phase B: RRF fusion | F186 Phase A: N-collection fan-out via LibraryCatalog

import type {
  CollectionGroup,
  CollectionManifest,
  EvidenceItem,
  EvidenceSearchExecution,
  IEvidenceStore,
  IKnowledgeResolver,
  KnowledgeResult,
  SearchExecutionMeta,
  SearchOptions,
} from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { redactForTranscript } from './privacy-redactor.js';
import { redactGroupsForPersistence } from './RecallPersistenceRedactor.js';

interface KnowledgeResolverDeps {
  projectStore: IEvidenceStore;
  globalStore?: IEvidenceStore;
  catalog?: LibraryCatalog;
  stores?: Map<string, IEvidenceStore>;
}

export class KnowledgeResolver implements IKnowledgeResolver {
  private readonly projectStore: IEvidenceStore;
  private readonly globalStore: IEvidenceStore | undefined;
  private readonly catalog: LibraryCatalog | undefined;
  private readonly stores: Map<string, IEvidenceStore>;

  constructor(deps: KnowledgeResolverDeps) {
    this.projectStore = deps.projectStore;
    this.globalStore = deps.globalStore ?? undefined;
    this.catalog = deps.catalog;
    this.stores = deps.stores ?? new Map();
  }

  async resolve(query: string, options?: SearchOptions): Promise<KnowledgeResult> {
    const limit = options?.limit ?? 10;
    const dimension = options?.dimension ?? 'all';

    if (dimension === 'library' || dimension === 'collection') {
      if (!this.catalog) return { results: [], sources: [], query, collectionGroups: [] };
      return this.resolveNCollection(query, options, limit, dimension);
    }

    const result = await this.resolveLegacy(query, options, limit, dimension);
    if (dimension === 'all') {
      result.deprecationWarnings = [
        'dimension: "all" is deprecated. Use dimension: "library" for multi-collection search.',
      ];
    }
    return result;
  }

  private async resolveNCollection(
    query: string,
    options: SearchOptions | undefined,
    limit: number,
    dimension: 'library' | 'collection',
  ): Promise<KnowledgeResult> {
    const manifests = this.catalog!.getRoutable(dimension, options?.collections);
    const groups: CollectionGroup[] = [];

    const metas: SearchExecutionMeta[] = [];
    const settled = await Promise.allSettled(
      manifests.map(async (m) => {
        const store = this.stores.get(m.id);
        if (!store) return { manifest: m, items: [] as EvidenceItem[], noStore: true };
        const start = Date.now();
        const execution = await searchStoreWithMeta(store, query, { ...options, limit });
        return {
          manifest: m,
          items: execution.items,
          meta: execution.meta,
          durationMs: Date.now() - start,
          noStore: false,
        };
      }),
    );

    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        const { manifest: m, items, meta, durationMs, noStore } = entry.value;
        if (meta) metas.push(meta);
        groups.push({
          collectionId: m.id,
          sensitivity: m.sensitivity,
          status: noStore ? 'skipped' : 'ok',
          durationMs: durationMs ?? 0,
          items: noStore ? [] : redactForTranscript(items, m.sensitivity),
        });
      } else {
        const m = manifests[settled.indexOf(entry)] as CollectionManifest;
        metas.push({ degraded: true, degradeReason: 'evidence_store_error' });
        groups.push({
          collectionId: m.id,
          sensitivity: m.sensitivity,
          status: 'error',
          durationMs: 0,
          items: [],
        });
      }
    }

    const fused = rrfFusionN(groups, limit);
    const sources: KnowledgeResult['sources'] = [];
    for (const g of groups) {
      if (g.items.length > 0 && g.collectionId.startsWith('project:') && !sources.includes('project'))
        sources.push('project');
      if (g.items.length > 0 && g.collectionId.startsWith('global:') && !sources.includes('global'))
        sources.push('global');
    }

    return {
      results: fused,
      sources,
      query,
      meta: combineSearchMeta(metas),
      collectionGroups: redactGroupsForPersistence(groups),
    };
  }

  private async resolveLegacy(
    query: string,
    options: SearchOptions | undefined,
    limit: number,
    dimension: string,
  ): Promise<KnowledgeResult> {
    if (dimension === 'project') {
      const execution = await searchStoreWithMeta(this.projectStore, query, { ...options, limit });
      return { results: execution.items.slice(0, limit), sources: ['project'], query, meta: execution.meta };
    }

    if (dimension === 'global') {
      if (!this.globalStore) return { results: [], sources: [], query };
      const execution = await searchStoreWithMeta(this.globalStore, query, { ...options, limit }).catch(
        () =>
          ({
            items: [],
            meta: { degraded: true, degradeReason: 'evidence_store_error' },
          }) satisfies EvidenceSearchExecution,
      );
      const results = execution.items;
      return {
        results: results.slice(0, limit),
        sources: results.length > 0 ? ['global'] : [],
        query,
        meta: execution.meta,
      };
    }

    const sources: KnowledgeResult['sources'] = [];
    const projectPromise = searchStoreWithMeta(this.projectStore, query, { ...options, limit });
    const globalPromise = this.globalStore
      ? searchStoreWithMeta(this.globalStore, query, { ...options, limit }).catch(
          () =>
            ({
              items: [],
              meta: { degraded: true, degradeReason: 'evidence_store_error' },
            }) satisfies EvidenceSearchExecution,
        )
      : Promise.resolve(null);

    const [projectExecution, globalExecution] = await Promise.all([projectPromise, globalPromise]);
    const projectResults = projectExecution.items;
    sources.push('project');

    if (!globalExecution || globalExecution.items.length === 0) {
      return {
        results: projectResults.slice(0, limit),
        sources,
        query,
        meta: combineSearchMeta([projectExecution.meta, globalExecution?.meta]),
      };
    }

    sources.push('global');
    const globalResults = globalExecution.items;
    const fused = rrfFusion(projectResults, globalResults, limit);
    return { results: fused, sources, query, meta: combineSearchMeta([projectExecution.meta, globalExecution.meta]) };
  }
}

async function searchStoreWithMeta(
  store: IEvidenceStore,
  query: string,
  options?: SearchOptions,
): Promise<EvidenceSearchExecution> {
  if (store.searchWithMeta) return store.searchWithMeta(query, options);
  return { items: await store.search(query, options), meta: legacyStoreMeta(options) };
}

function legacyStoreMeta(options?: SearchOptions): SearchExecutionMeta {
  if (isRawNonLexical(options)) {
    return { degraded: true, degradeReason: 'raw_lexical_only', effectiveMode: 'lexical' };
  }
  return { degraded: false };
}

function combineSearchMeta(metas: Array<SearchExecutionMeta | undefined>): SearchExecutionMeta {
  const degradedMetas = metas.filter((meta): meta is SearchExecutionMeta => Boolean(meta?.degraded));
  if (degradedMetas.length === 0) return { degraded: false };

  const selected = degradedMetas.reduce((best, current) =>
    degradeReasonPriority(current.degradeReason) > degradeReasonPriority(best.degradeReason) ? current : best,
  );
  return {
    degraded: true,
    ...(selected.degradeReason ? { degradeReason: selected.degradeReason } : {}),
    ...(selected.effectiveMode ? { effectiveMode: selected.effectiveMode } : {}),
  };
}

function degradeReasonPriority(reason: SearchExecutionMeta['degradeReason']): number {
  switch (reason) {
    case 'evidence_store_error':
      return 4;
    case 'passage_vector_search_error':
      return 3;
    case 'passage_embedding_unavailable':
      return 2;
    case 'raw_lexical_only':
      return 1;
    default:
      return 0;
  }
}

function isRawNonLexical(options?: SearchOptions): boolean {
  return options?.depth === 'raw' && (options.mode ?? 'lexical') !== 'lexical';
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────
// RRF(d) = Σ 1/(k + rank_i(d))  where k=60 (standard constant)

const RRF_K = 60;

function rrfFusion(projectItems: EvidenceItem[], globalItems: EvidenceItem[], limit: number): EvidenceItem[] {
  const scoreMap = new Map<string, { item: EvidenceItem; score: number }>();

  // Score project items (project gets a slight bias via lower ranks)
  for (let i = 0; i < projectItems.length; i++) {
    const item = projectItems[i]!;
    const score = 1 / (RRF_K + i);
    const existing = scoreMap.get(item.anchor);
    if (existing) {
      existing.score += score;
      // Project version wins for item data
    } else {
      scoreMap.set(item.anchor, { item, score });
    }
  }

  // Score global items
  for (let i = 0; i < globalItems.length; i++) {
    const item = globalItems[i]!;
    const score = 1 / (RRF_K + i);
    const existing = scoreMap.get(item.anchor);
    if (existing) {
      existing.score += score;
      // Keep project item data (dedup: project wins)
    } else {
      scoreMap.set(item.anchor, { item, score });
    }
  }

  // Sort by score descending, return top N
  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

function rrfFusionN(groups: CollectionGroup[], limit: number): EvidenceItem[] {
  const scoreMap = new Map<string, { item: EvidenceItem; score: number }>();
  for (const group of groups) {
    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i]!;
      const score = 1 / (RRF_K + i);
      const existing = scoreMap.get(item.anchor);
      if (existing) {
        existing.score += score;
      } else {
        scoreMap.set(item.anchor, { item, score });
      }
    }
  }
  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
