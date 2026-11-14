import type { ConventionGraphAdapter } from './coverage-search-expansion.js';
import { blockedExpansionHealth, failedExpansionHealth, successfulExpansionHealth } from './expansion-health.js';
import type { EvidenceItem, IKnowledgeResolver, KnowledgeResult, SearchOptions } from './interfaces.js';
import { KnowledgeAssociations } from './knowledge-associations.js';
import { checkDiscoveryLifetime } from './knowledge-discovery.js';
import { L0ConventionGraphAdapter } from './L0ConventionGraphAdapter.js';

export async function resolveKnowledgeAssociations(
  resolver: IKnowledgeResolver,
  items: EvidenceItem[],
  query: string,
  options: SearchOptions,
  deps: {
    repoRoot?: string;
    conventionGraph?: ConventionGraphAdapter | null;
    projectStore: { searchWithMeta?: unknown };
  },
): Promise<Pick<KnowledgeResult, 'expansionHints' | 'expansionMeta'>> {
  if (!options.includeExpansion) return { expansionMeta: blockedExpansionHealth('opt_out') };
  if (options.threadId) return { expansionMeta: blockedExpansionHealth('exact_thread_filter') };
  if (!items.length) return { expansionMeta: blockedExpansionHealth('no_results') };
  if (!deps.projectStore.searchWithMeta) return { expansionMeta: blockedExpansionHealth('store_unsupported') };
  try {
    // Convention edges belong to the project source. A collection-only query cannot widen into it.
    const projectScope = !options.dimension || options.dimension === 'all' || options.dimension === 'project';
    const graph =
      projectScope && (!options.scope || options.scope === 'all' || options.scope === 'docs')
        ? (deps.conventionGraph ?? new L0ConventionGraphAdapter(deps.repoRoot ?? process.cwd()))
        : null;
    const associations = new KnowledgeAssociations(
      {
        searchWithMeta: async (term, requested) => {
          checkDiscoveryLifetime(options);
          if (options.scope && options.scope !== 'all' && options.scope !== requested?.scope)
            return { items: [], meta: { degraded: false } };
          const found = await resolver.resolve(term, {
            ...options,
            ...requested,
            includeExpansion: false,
            dimension: options.dimension,
            collections: options.collections,
            authorizedCollections: options.authorizedCollections,
            signal: options.signal,
            deadlineAt: options.deadlineAt,
          });
          return { items: found.results, meta: found.meta ?? { degraded: false } };
        },
      },
      graph,
      options,
    );
    const expanded = await associations.expandWithMeta(items, query);
    return {
      expansionHints: expanded.hints,
      expansionMeta: successfulExpansionHealth(expanded.funnel, expanded.hints),
    };
  } catch {
    checkDiscoveryLifetime(options);
    return { expansionMeta: failedExpansionHealth() };
  }
}
