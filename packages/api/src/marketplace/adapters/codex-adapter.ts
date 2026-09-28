import type {
  InstallPlan,
  MarketplaceAdapter,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
  MarketplaceSourceStatus,
} from '@cat-cafe/shared';
import type {
  ProviderNativeCapabilityArtifact,
  ProviderNativeCapabilitySource,
} from '../../domains/cats/services/types.js';

export interface CodexAdapterOptions {
  sourceLoader: () => Promise<ProviderNativeCapabilitySource>;
}

export function deduplicateInFlightCapabilitySource(
  sourceLoader: () => Promise<ProviderNativeCapabilitySource>,
): () => Promise<ProviderNativeCapabilitySource> {
  let inFlight: Promise<ProviderNativeCapabilitySource> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const current = sourceLoader();
    inFlight = current;
    const clear = (): void => {
      if (inFlight === current) inFlight = undefined;
    };
    void current.then(clear, clear);
    return current;
  };
}

export class CodexMarketplaceAdapter implements MarketplaceAdapter {
  readonly ecosystem = 'codex' as const;

  constructor(private readonly options: CodexAdapterOptions) {}

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult[]> {
    return (await this.searchWithStatus(query)).results;
  }

  async searchWithStatus(query: MarketplaceSearchQuery): Promise<{
    results: MarketplaceSearchResult[];
    status: MarketplaceSourceStatus;
  }> {
    try {
      const snapshot = await this.loadSource();
      const q = query.query.toLowerCase();
      return {
        results: snapshot.artifacts
          .filter((entry) => [entry.name, entry.description, entry.id].some((value) => value.toLowerCase().includes(q)))
          .map((entry) => toSearchResult(entry, snapshot)),
        status: {
          ecosystem: 'codex',
          sourceKind: 'provider',
          availability: snapshot.availability,
          providerVersion: snapshot.providerVersion,
          observedAt: snapshot.observedAt,
          ...(snapshot.issues.length > 0 ? { issues: [...snapshot.issues] } : {}),
        },
      };
    } catch {
      return {
        results: [],
        status: {
          ecosystem: 'codex',
          sourceKind: 'provider',
          availability: 'unavailable',
          issues: ['Codex provider source unavailable'],
        },
      };
    }
  }

  async buildInstallPlan(artifactId: string): Promise<InstallPlan> {
    const snapshot = await this.loadSource();
    const entry = snapshot.artifacts.find((artifact) => artifact.id === artifactId);
    if (!entry) throw new Error('Codex artifact "' + artifactId + '" not found');
    return {
      mode: 'manual_ui',
      manualSteps: [
        '在 Clowder AI 现有能力与插件设置中确认安装、授权、密钥和启停状态。',
        'Codex provider source 只提供实时发现与状态证据，不会在浏览时修改提供商配置。',
      ],
      metadata: {
        ...(entry.versionRef ? { versionRef: entry.versionRef } : {}),
        publisherIdentity: entry.publisher,
        providerVersion: snapshot.providerVersion,
      },
    };
  }

  private async loadSource(): Promise<ProviderNativeCapabilitySource> {
    try {
      return await this.options.sourceLoader();
    } catch {
      throw new Error('Codex provider source unavailable');
    }
  }
}

function toSearchResult(
  entry: ProviderNativeCapabilityArtifact,
  snapshot: ProviderNativeCapabilitySource,
): MarketplaceSearchResult {
  return {
    artifactId: entry.id,
    artifactKind: entry.kind,
    displayName: entry.name,
    ecosystem: 'codex',
    sourceLocator: entry.sourceLocator,
    trustLevel: entry.trustLevel,
    componentSummary: entry.description,
    ...(entry.versionRef ? { versionRef: entry.versionRef } : {}),
    publisherIdentity: entry.publisher,
    providerSource: {
      providerVersion: snapshot.providerVersion,
      observedAt: snapshot.observedAt,
    },
    ...(entry.lifecycle ? { lifecycle: entry.lifecycle } : {}),
  };
}
