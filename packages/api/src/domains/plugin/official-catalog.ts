import type { Capability } from '@clowder-ai/plugin-contract';

export interface OfficialPluginOwnerAuth {
  readonly kind: 'lark-cli-device';
  /** Package-relative, immutable runner admitted with the official archive. */
  readonly runnerPath: string;
  readonly domains: readonly string[];
}

export interface OfficialPluginCatalogEntry {
  readonly catalogId: string;
  readonly packageName: string;
  readonly version: string;
  readonly pluginId: string;
  readonly archiveUrl: string;
  readonly packageDigest: string;
  readonly effectiveGrants: readonly Capability[];
  readonly ownerAuth?: OfficialPluginOwnerAuth;
}

export const OFFICIAL_PLUGIN_CATALOG = [
  {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    version: '0.1.0-alpha.3',
    pluginId: 'official.feishu-meeting-intake',
    archiveUrl:
      'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.3.tgz',
    packageDigest: 'sha512-cIrmZGup33W/L0XP9Q6b/OxgNR2oC5lCs1EAc3FcXhfQSJLDw3e/9di1vOGQZwN1Fm19Q0gMXKCxT1rg6WDNBg==',
    effectiveGrants: ['events.publish'],
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
      domains: ['event', 'minutes', 'note', 'vc'],
    },
  },
] as const satisfies readonly OfficialPluginCatalogEntry[];
