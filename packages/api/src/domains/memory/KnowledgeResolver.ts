import type { CollectionSensitivity } from './collection-types.js';
import type { ConventionGraphAdapter } from './coverage-search-expansion.js';
import type {
  CollectionGroup,
  EvidenceItem,
  IEvidenceStore,
  IKnowledgeResolver,
  KnowledgeResult,
  SearchExecutionMeta,
  SearchOptions,
} from './interfaces.js';
import { resolveKnowledgeAssociations } from './knowledge-association-result.js';
import { discoverKnowledge, type KnowledgeDiscoverySource } from './knowledge-discovery.js';
import { combineSearchMeta, documentDiscoverySource } from './knowledge-document-source.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { redactGroupsForPersistence } from './RecallPersistenceRedactor.js';

interface KnowledgeResolverDeps {
  projectStore: IEvidenceStore;
  repoRoot?: string;
  conventionGraph?: ConventionGraphAdapter | null;
  globalStore?: IEvidenceStore;
  catalog?: LibraryCatalog;
  stores?: Map<string, IEvidenceStore>;
}

/** One candidate/admission/fusion core; native adapters retain their source contracts. */
export class KnowledgeResolver implements IKnowledgeResolver {
  static readonly discover = discoverKnowledge;

  constructor(private readonly deps: KnowledgeResolverDeps) {}

  async resolve(query: string, options?: SearchOptions): Promise<KnowledgeResult> {
    const limit = options?.limit ?? 10;
    const dimension = options?.dimension ?? 'all';
    const library = dimension === 'library' || dimension === 'collection';
    const metas: SearchExecutionMeta[] = [];
    const groups: CollectionGroup[] = [];
    const adapters: KnowledgeDiscoverySource<EvidenceItem, EvidenceItem>[] = [];
    const sourceKinds = new Map<string, 'project' | 'global'>();
    const add = (
      id: string,
      store: IEvidenceStore | undefined,
      generic: boolean,
      sensitivity?: CollectionSensitivity,
    ) => {
      if (library)
        groups.push({
          collectionId: id,
          sensitivity: sensitivity!,
          status: store ? 'ok' : 'skipped',
          durationMs: 0,
          items: [],
        });
      if (!store) return;
      if (id.startsWith('global:')) sourceKinds.set(id, 'global');
      else if (id.startsWith('project:')) sourceKinds.set(id, 'project');
      const adapter = documentDiscoverySource({
        id,
        store,
        options,
        generic,
        sensitivity,
        tolerateError: library || id === 'global:legacy',
        onMeta: (meta) => metas.push(meta),
      });
      const read = adapter.read;
      adapter.read = async (request) => {
        const started = Date.now();
        try {
          return await read(request);
        } finally {
          const group = groups.find((item) => item.collectionId === id);
          if (group) group.durationMs += Date.now() - started;
        }
      };
      adapters.push(adapter);
    };
    if (library) {
      for (const manifest of this.deps.catalog?.getRoutable(
        dimension,
        options?.collections,
        options?.authorizedCollections,
      ) ?? [])
        add(manifest.id, this.deps.stores?.get(manifest.id), true, manifest.sensitivity);
    } else {
      if (dimension !== 'global') add('project:legacy', this.deps.projectStore, false);
      if (
        dimension === 'global' ||
        (dimension !== 'project' && options?.scope !== 'threads' && options?.scope !== 'sessions')
      )
        add('global:legacy', this.deps.globalStore, true);
    }
    const discovery = await KnowledgeResolver.discover(query, {
      sources: adapters,
      limit,
      signal: options?.signal,
      deadlineAt: options?.deadlineAt,
      candidateBudget: Math.min(Math.max(limit * 4, 100), 1000),
    });
    for (const source of discovery.sources) {
      const group = groups.find((item) => item.collectionId === source.sourceId);
      if (group) {
        group.items = source.items;
        group.status = source.stopReason === 'error' ? 'error' : 'ok';
      }
      if (source.stopReason === 'error') metas.push({ degraded: true, degradeReason: 'evidence_store_error' });
    }
    const sources: KnowledgeResult['sources'] = [];
    for (const source of discovery.sources) {
      const kind = sourceKinds.get(source.sourceId);
      if (!kind) continue;
      if ((source.items.length || (!library && kind === 'project')) && !sources.includes(kind)) sources.push(kind);
    }
    const result: KnowledgeResult = {
      results: discovery.items,
      sources,
      query,
      meta: combineSearchMeta(metas),
      resolverVersion: discovery.version,
      ...(library ? { collectionGroups: redactGroupsForPersistence(groups) } : {}),
      ...(dimension === 'all'
        ? {
            deprecationWarnings: [
              'dimension: "all" is deprecated. Use dimension: "library" for multi-collection search.',
            ],
          }
        : {}),
    };
    if (options?.includeExpansion !== undefined) {
      Object.assign(result, await resolveKnowledgeAssociations(this, result.results, query, options, this.deps));
    }
    return result;
  }
}
