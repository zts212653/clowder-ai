import type {
  InstallPlan,
  MarketplaceAdapter,
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
    const targetAdapters = query.ecosystems
      ? [...this.adapters.values()].filter((a) => query.ecosystems!.includes(a.ecosystem))
      : [...this.adapters.values()];

    const settled = await Promise.allSettled(targetAdapters.map((a) => a.search(query)));

    let results: MarketplaceSearchResult[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
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

    return results;
  }

  async buildInstallPlan(ecosystem: string, artifactId: string): Promise<InstallPlan> {
    const adapter = this.adapters.get(ecosystem);
    if (!adapter) throw new Error(`No adapter for ecosystem: ${ecosystem}`);
    return adapter.buildInstallPlan(artifactId);
  }
}
