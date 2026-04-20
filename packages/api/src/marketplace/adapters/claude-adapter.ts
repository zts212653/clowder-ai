import type {
  InstallPlan,
  MarketplaceAdapter,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
  McpTransport,
} from '@cat-cafe/shared';

export interface ClaudeCatalogEntry {
  id: string;
  name: string;
  description: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: McpTransport;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  trustLevel: 'official' | 'verified' | 'community';
  publisher: string;
  versionRef?: string;
}

export interface ClaudeAdapterOptions {
  catalogLoader: () => Promise<ClaudeCatalogEntry[]>;
}

export class ClaudeMarketplaceAdapter implements MarketplaceAdapter {
  readonly ecosystem = 'claude' as const;
  private catalogLoader: () => Promise<ClaudeCatalogEntry[]>;
  private cachedCatalog: ClaudeCatalogEntry[] | null = null;

  constructor(options: ClaudeAdapterOptions) {
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
    if (!entry) throw new Error(`Claude artifact "${artifactId}" not found`);

    return {
      mode: 'direct_mcp',
      mcpEntry: {
        id: entry.id,
        command: entry.command,
        args: entry.args,
        url: entry.url,
        transport: entry.transport,
        env: entry.env,
        headers: entry.headers,
      },
      metadata: {
        versionRef: entry.versionRef,
        publisherIdentity: entry.publisher,
      },
    };
  }

  private async getCatalog(): Promise<ClaudeCatalogEntry[]> {
    if (!this.cachedCatalog) {
      this.cachedCatalog = await this.catalogLoader();
    }
    return this.cachedCatalog;
  }

  private toSearchResult(entry: ClaudeCatalogEntry): MarketplaceSearchResult {
    return {
      artifactId: entry.id,
      artifactKind: 'mcp_server',
      displayName: entry.name,
      ecosystem: 'claude',
      sourceLocator: entry.url ?? `npx:${entry.args?.[1] ?? entry.command ?? ''}`,
      trustLevel: entry.trustLevel,
      componentSummary: entry.description,
      transport: entry.transport ?? 'stdio',
      versionRef: entry.versionRef,
      publisherIdentity: entry.publisher,
    };
  }
}
