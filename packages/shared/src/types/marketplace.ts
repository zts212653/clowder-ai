import type { McpInstallRequest, McpTransport } from './capability.js';

export type MarketplaceEcosystem = 'claude' | 'codex' | 'openclaw' | 'antigravity';
export type MarketplaceArtifactKind = 'mcp_server' | 'skill' | 'app' | 'plugin' | 'bundle' | 'pack';
export type TrustLevel = 'official' | 'verified' | 'community';
export type InstallMode = 'direct_mcp' | 'delegated_cli' | 'manual_file' | 'manual_ui';

export const MARKETPLACE_ECOSYSTEMS: MarketplaceEcosystem[] = ['claude', 'codex', 'openclaw', 'antigravity'];
export const MARKETPLACE_ARTIFACT_KINDS: MarketplaceArtifactKind[] = [
  'mcp_server',
  'skill',
  'app',
  'plugin',
  'bundle',
  'pack',
];
export const TRUST_LEVELS: TrustLevel[] = ['official', 'verified', 'community'];
export const INSTALL_MODES: InstallMode[] = ['direct_mcp', 'delegated_cli', 'manual_file', 'manual_ui'];

export interface MarketplaceSearchQuery {
  query: string;
  ecosystems?: MarketplaceEcosystem[];
  trustLevels?: TrustLevel[];
  artifactKinds?: MarketplaceArtifactKind[];
  limit?: number;
}

export interface MarketplaceSearchResult {
  artifactId: string;
  artifactKind: MarketplaceArtifactKind;
  displayName: string;
  ecosystem: MarketplaceEcosystem;
  sourceLocator: string;
  trustLevel: TrustLevel;
  componentSummary: string;
  transport?: McpTransport;
  versionRef?: string;
  publisherIdentity?: string;
  providerSource?: {
    providerVersion: string;
    observedAt: string;
  };
  lifecycle?: {
    installed?: boolean;
    enabled?: boolean;
    accessible?: boolean;
    callable?: boolean;
    maturity?: 'stable' | 'experimental';
    authPolicy?: string;
    authStatus?: string;
    runtimeStatus?: string;
    toolCount?: number;
    resourceCount?: number;
    resourceTemplateCount?: number;
    pluginId?: string;
  };
}

export interface MarketplaceSourceStatus {
  ecosystem: MarketplaceEcosystem;
  sourceKind: 'catalog' | 'provider';
  availability: 'live' | 'degraded' | 'unavailable';
  providerVersion?: string;
  observedAt?: string;
  issues?: string[];
}

export interface MarketplaceSearchPage {
  results: MarketplaceSearchResult[];
  sources: MarketplaceSourceStatus[];
}

export interface InstallPlan {
  mode: InstallMode;
  mcpEntry?: McpInstallRequest;
  delegatedCommand?: string;
  manualSteps?: string[];
  hasInstallScripts?: boolean;
  scriptDetails?: string;
  metadata?: {
    versionRef?: string;
    publisherIdentity?: string;
    toolSnapshotHash?: string;
    providerVersion?: string;
  };
}

export interface MarketplaceAdapter {
  readonly ecosystem: MarketplaceEcosystem;
  search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult[]>;
  searchWithStatus?(query: MarketplaceSearchQuery): Promise<{
    results: MarketplaceSearchResult[];
    status: MarketplaceSourceStatus;
  }>;
  buildInstallPlan(artifactId: string): Promise<InstallPlan>;
}
