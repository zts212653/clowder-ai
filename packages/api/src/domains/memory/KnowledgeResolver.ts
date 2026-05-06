// F102+F186: IKnowledgeResolver — federated search across N collections
// F102 Phase B: RRF fusion | F186 Phase A: N-collection fan-out via LibraryCatalog

import type {
  CollectionGroup,
  CollectionManifest,
  EvidenceItem,
  IEvidenceStore,
  IKnowledgeResolver,
  KnowledgeResult,
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

    const settled = await Promise.allSettled(
      manifests.map(async (m) => {
        const store = this.stores.get(m.id);
        if (!store) return { manifest: m, items: [] as EvidenceItem[], noStore: true };
        const start = Date.now();
        const items = await store.search(query, { ...options, limit });
        return { manifest: m, items, durationMs: Date.now() - start, noStore: false };
      }),
    );

    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        const { manifest: m, items, durationMs, noStore } = entry.value;
        groups.push({
          collectionId: m.id,
          sensitivity: m.sensitivity,
          status: noStore ? 'skipped' : 'ok',
          durationMs: durationMs ?? 0,
          items: noStore ? [] : redactForTranscript(items, m.sensitivity),
        });
      } else {
        const m = manifests[settled.indexOf(entry)] as CollectionManifest;
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

    return { results: fused, sources, query, collectionGroups: redactGroupsForPersistence(groups) };
  }

  private async resolveLegacy(
    query: string,
    options: SearchOptions | undefined,
    limit: number,
    dimension: string,
  ): Promise<KnowledgeResult> {
    if (dimension === 'project') {
      const results = await this.projectStore.search(query, { ...options, limit });
      return { results: results.slice(0, limit), sources: ['project'], query };
    }

    if (dimension === 'global') {
      if (!this.globalStore) return { results: [], sources: [], query };
      const results = await this.globalStore.search(query, { ...options, limit }).catch(() => []);
      return {
        results: results.slice(0, limit),
        sources: results.length > 0 ? ['global'] : [],
        query,
      };
    }

    const sources: KnowledgeResult['sources'] = [];
    const projectPromise = this.projectStore.search(query, { ...options, limit });
    const globalPromise = this.globalStore
      ? this.globalStore.search(query, { ...options, limit }).catch(() => null)
      : Promise.resolve(null);

    const [projectResults, globalResults] = await Promise.all([projectPromise, globalPromise]);
    sources.push('project');

    if (!globalResults || globalResults.length === 0) {
      return { results: projectResults.slice(0, limit), sources, query };
    }

    sources.push('global');
    const fused = rrfFusion(projectResults, globalResults, limit);
    return { results: fused, sources, query };
  }
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
