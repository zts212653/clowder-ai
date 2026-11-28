import type { PluginPackageProvenance } from '../host-inventory/types.js';

export const officialDshClient = {
  pluginId: 'official.agent-dsh',
  contributionId: 'dsh',
  catalogId: 'agent-dsh',
  packageName: '@clowder-ai/agent-dsh',
  command: 'dsh',
} as const;
export const dshDesktopAdapterRef = 'plugin:official.agent-dsh/dsh';

export const officialNativeClients = [
  {
    pluginId: 'official.agent-kimi',
    legacyDiscoveryId: 'kimi',
    contributionId: 'kimi',
    catalogId: 'agent-kimi',
    packageName: '@clowder-ai/agent-kimi',
    command: 'kimi',
    terminalCommand: '/usage',
  },
  {
    pluginId: 'official.agent-codex',
    legacyDiscoveryId: 'codex',
    contributionId: 'codex',
    catalogId: 'agent-codex',
    packageName: '@clowder-ai/agent-codex',
    command: 'codex',
  },
  {
    pluginId: 'official.agent-claude-code',
    legacyDiscoveryId: 'claude',
    contributionId: 'claude-code',
    catalogId: 'agent-claude-code',
    packageName: '@clowder-ai/agent-claude-code',
    command: 'claude',
  },
  {
    pluginId: 'official.agent-agy',
    legacyDiscoveryId: 'agy-native',
    contributionId: 'agy',
    catalogId: 'agent-agy',
    packageName: '@clowder-ai/agent-agy',
    command: 'agy',
  },
  { ...officialDshClient, legacyDiscoveryId: undefined, terminalCommand: undefined },
];

export function matchesOfficialAgentCatalog(
  client: Pick<(typeof officialNativeClients)[number], 'catalogId' | 'packageName'>,
  source: PluginPackageProvenance | undefined,
) {
  return (
    source?.kind === 'catalog' && source.catalogId === client.catalogId && source.packageName === client.packageName
  );
}
