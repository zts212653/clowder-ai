import type {
  InstallPlan,
  MarketplaceAdapter,
  MarketplaceArtifactKind,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
} from '@cat-cafe/shared';

export interface CodexCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind?: 'mcp_server' | 'plugin';
  command?: string;
  args?: string[];
  serverUrl?: string;
  env_vars?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  enabled_tools?: string[];
  cliInstallCommand?: string;
  trustLevel: 'official' | 'verified' | 'community';
  publisher: string;
  versionRef?: string;
}

export interface CodexAdapterOptions {
  catalogLoader: () => Promise<CodexCatalogEntry[]>;
}

export class CodexMarketplaceAdapter implements MarketplaceAdapter {
  readonly ecosystem = 'codex' as const;
  private catalogLoader: () => Promise<CodexCatalogEntry[]>;
  private cachedCatalog: CodexCatalogEntry[] | null = null;

  constructor(options: CodexAdapterOptions) {
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
    if (!entry) throw new Error(`Codex artifact "${artifactId}" not found`);

    if (entry.kind === 'plugin' && entry.cliInstallCommand) {
      return {
        mode: 'delegated_cli',
        delegatedCommand: entry.cliInstallCommand,
        metadata: { versionRef: entry.versionRef, publisherIdentity: entry.publisher },
      };
    }

    return {
      mode: 'direct_mcp',
      mcpEntry: {
        id: entry.id,
        command: entry.command,
        args: entry.args,
        url: entry.serverUrl,
        transport: entry.serverUrl ? 'streamableHttp' : undefined,
        env: entry.env_vars,
        headers: entry.env_http_headers,
      },
      metadata: { versionRef: entry.versionRef, publisherIdentity: entry.publisher },
    };
  }

  private async getCatalog(): Promise<CodexCatalogEntry[]> {
    if (!this.cachedCatalog) {
      this.cachedCatalog = await this.catalogLoader();
    }
    return this.cachedCatalog;
  }

  private toSearchResult(entry: CodexCatalogEntry): MarketplaceSearchResult {
    const artifactKind: MarketplaceArtifactKind = entry.kind === 'plugin' ? 'plugin' : 'mcp_server';
    return {
      artifactId: entry.id,
      artifactKind,
      displayName: entry.name,
      ecosystem: 'codex',
      sourceLocator: entry.serverUrl ?? `cli:${entry.command ?? ''}`,
      trustLevel: entry.trustLevel,
      componentSummary: entry.description,
      transport: entry.serverUrl ? 'streamableHttp' : 'stdio',
      versionRef: entry.versionRef,
      publisherIdentity: entry.publisher,
    };
  }
}
