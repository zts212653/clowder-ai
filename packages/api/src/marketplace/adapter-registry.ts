import type {
  InstallPlan,
  MarketplaceAdapter,
  MarketplaceEcosystem,
  MarketplaceSearchPage,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
} from '@cat-cafe/shared';

export class AdapterRegistry {
  private adapters = new Map<string, MarketplaceAdapter>();

  register(adapter: MarketplaceAdapter): void {
    this.adapters.set(adapter.ecosystem, adapter);
  }

  get(ecosystem: string): MarketplaceAdapter | undefined {
    return this.adapters.get(ecosystem);
  }

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult[]> {
    return (await this.searchDetailed(query)).results;
  }

  async searchDetailed(query: MarketplaceSearchQuery): Promise<MarketplaceSearchPage> {
    const targetAdapters = query.ecosystems
      ? [...this.adapters.values()].filter((a) => query.ecosystems!.includes(a.ecosystem))
      : [...this.adapters.values()];

    const settled = await Promise.allSettled(
      targetAdapters.map(async (adapter) => {
        if (adapter.searchWithStatus) return adapter.searchWithStatus(query);
        return {
          results: await adapter.search(query),
          status: {
            ecosystem: adapter.ecosystem,
            sourceKind: 'catalog' as const,
            availability: 'live' as const,
          },
        };
      }),
    );

    let results: MarketplaceSearchResult[] = [];
    const sources: MarketplaceSearchPage['sources'] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value.results);
        sources.push(result.value.status);
      }
    }

    if (query.trustLevels?.length) {
      results = results.filter((r) => query.trustLevels!.includes(r.trustLevel));
    }
    if (query.artifactKinds?.length) {
      results = results.filter((r) => query.artifactKinds!.includes(r.artifactKind));
    }
    if (query.limit && query.limit > 0 && results.length > query.limit) {
      results = results.slice(0, query.limit);
    }

    return { results, sources };
  }

  async buildInstallPlan(ecosystem: string, artifactId: string): Promise<InstallPlan> {
    const adapter = this.adapters.get(ecosystem);
    if (!adapter) throw new Error(`No adapter for ecosystem: ${ecosystem}`);
    const plan = await adapter.buildInstallPlan(artifactId);
    if (plan.mode === 'direct_mcp' && plan.mcpEntry && !plan.mcpEntry.ecosystem) {
      plan.mcpEntry.ecosystem = ecosystem as MarketplaceEcosystem;
    }
    return plan;
  }
}
