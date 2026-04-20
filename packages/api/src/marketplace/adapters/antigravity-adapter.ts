import type {
  InstallPlan,
  MarketplaceAdapter,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
} from '@cat-cafe/shared';

export interface AntigravityCatalogEntry {
  id: string;
  name: string;
  description: string;
  trustLevel: 'official' | 'verified' | 'community';
  publisher: string;
  resolver?: string;
  versionRef?: string;
}

export interface AntigravityAdapterOptions {
  catalogLoader: () => Promise<AntigravityCatalogEntry[]>;
}

export class AntigravityMarketplaceAdapter implements MarketplaceAdapter {
  readonly ecosystem = 'antigravity' as const;
  private catalogLoader: () => Promise<AntigravityCatalogEntry[]>;
  private cachedCatalog: AntigravityCatalogEntry[] | null = null;

  constructor(options: AntigravityAdapterOptions) {
    this.catalogLoader = options.catalogLoader;
  }

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult[]> {
    const catalog = await this.getCatalog();
    const q = query.query.toLowerCase();
    return catalog
      .filter(
        (e) =>
          e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
      )
      .map((e) => this.toSearchResult(e));
  }

  async buildInstallPlan(artifactId: string): Promise<InstallPlan> {
    const catalog = await this.getCatalog();
    const entry = catalog.find((e) => e.id === artifactId);
    if (!entry) throw new Error(`Antigravity artifact "${artifactId}" not found`);

    if (entry.resolver) {
      return {
        mode: 'manual_file',
        manualSteps: [
          `This extension uses resolver "${entry.resolver}" — it's managed by the Cat Cafe capability system.`,
          'If not already installed, check Antigravity Extensions marketplace.',
          `After installing the extension, Cat Cafe will auto-detect it via the "${entry.resolver}" resolver.`,
        ],
        metadata: { versionRef: entry.versionRef, publisherIdentity: entry.publisher },
      };
    }

    return {
      mode: 'manual_ui',
      manualSteps: [
        `Open Antigravity Extensions marketplace.`,
        `Search for "${entry.name}" by ${entry.publisher}.`,
        'Click Install in the Antigravity UI.',
        'Antigravity auto-install API is not yet publicly available.',
      ],
      metadata: { versionRef: entry.versionRef, publisherIdentity: entry.publisher },
    };
  }

  private async getCatalog(): Promise<AntigravityCatalogEntry[]> {
    if (!this.cachedCatalog) {
      this.cachedCatalog = await this.catalogLoader();
    }
    return this.cachedCatalog;
  }

  private toSearchResult(entry: AntigravityCatalogEntry): MarketplaceSearchResult {
    return {
      artifactId: entry.id,
      artifactKind: 'mcp_server',
      displayName: entry.name,
      ecosystem: 'antigravity',
      sourceLocator: `antigravity:${entry.id}`,
      trustLevel: entry.trustLevel,
      componentSummary: entry.description,
      publisherIdentity: entry.publisher,
    };
  }
}
