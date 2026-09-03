import { createHash } from 'node:crypto';
import type { MeetingIntakeJudgmentField } from '@cat-cafe/shared';
import type { Capability, PluginManifest } from '@clowder-ai/plugin-contract';

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
  readonly distribution: 'registry' | 'bundled';
  readonly archiveUrl: string;
  readonly packageDigest: string;
  readonly effectiveGrants: readonly Capability[];
  readonly ownerAuth?: OfficialPluginOwnerAuth;
}

export interface OfficialPluginRelease {
  readonly version: string;
  readonly archiveUrl: string;
  readonly packageDigest: string;
}

export interface OfficialPluginSignalRoutePolicy {
  readonly routeId: string;
  readonly signalType: string;
  readonly workflowKind: 'meeting-intake';
  readonly initialUnresolved: readonly MeetingIntakeJudgmentField[];
}

export interface OfficialPluginCatalogPolicy {
  readonly catalogId: string;
  readonly packageName: string;
  readonly pluginId: string;
  readonly distribution: 'registry' | 'bundled';
  readonly releaseTag: 'next';
  readonly bootstrapRelease: OfficialPluginRelease;
  readonly effectiveGrants: readonly Capability[];
  readonly ownerAuth?: OfficialPluginOwnerAuth;
  readonly hostSignalRoutes: readonly OfficialPluginSignalRoutePolicy[];
}

export function officialPluginCatalogEntry(
  policy: OfficialPluginCatalogPolicy,
  release: OfficialPluginRelease = policy.bootstrapRelease,
): OfficialPluginCatalogEntry {
  return {
    catalogId: policy.catalogId,
    packageName: policy.packageName,
    pluginId: policy.pluginId,
    distribution: policy.distribution,
    version: release.version,
    archiveUrl: release.archiveUrl,
    packageDigest: release.packageDigest,
    effectiveGrants: policy.effectiveGrants,
    ...(policy.ownerAuth === undefined ? {} : { ownerAuth: policy.ownerAuth }),
  };
}

export const COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST = {
  pluginId: 'official.collective-connector',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'Collective Connector',
  description: 'Pairs this Clowder AI Host with an independent Collective Service.',
  features: [
    {
      id: 'collective-connection',
      name: 'Collective connection',
      resources: [],
      capabilities: [],
    },
  ],
  data: [
    {
      name: 'collective-connections',
      dataClass: 'relationship',
      strategy: 'retained',
      schemaVersion: '1',
    },
    {
      name: 'collective-signal-custody',
      dataClass: 'interaction-history',
      strategy: 'retained',
      schemaVersion: '1',
    },
  ],
  runtime: { transport: 'builtin' },
} as const satisfies PluginManifest;

export function bundledManifestDigest(manifest: PluginManifest): string {
  return `sha512-${createHash('sha512').update(JSON.stringify(manifest)).digest('base64')}`;
}

export const OFFICIAL_PLUGIN_POLICIES = [
  {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    pluginId: 'official.feishu-meeting-intake',
    distribution: 'registry',
    releaseTag: 'next',
    bootstrapRelease: {
      version: '0.1.0-alpha.9',
      archiveUrl:
        'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.9.tgz',
      packageDigest: 'sha512-d1wf5Il1Ls18Db9EUB4S0qqhDFRe6mSLIyv9E3Tz7VqI59gffHCe+JKmCJOYVGJBiv1ItrTq8ChthF0SzdSWYQ==',
    },
    effectiveGrants: ['events.publish'],
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
      domains: ['event', 'minutes', 'note', 'vc'],
    },
    hostSignalRoutes: [
      {
        routeId: 'official:feishu-meeting-intake:meeting-intake',
        signalType: 'feishu.meeting_artifact.generated.v1',
        workflowKind: 'meeting-intake',
        initialUnresolved: ['speakers', 'context', 'destination', 'outputs'],
      },
    ],
  },
  {
    catalogId: 'collective-connector',
    packageName: '@cat-cafe/collective-connector',
    pluginId: 'official.collective-connector',
    distribution: 'bundled',
    releaseTag: 'next',
    bootstrapRelease: {
      version: '0.1.0',
      archiveUrl: 'builtin:official.collective-connector',
      packageDigest: bundledManifestDigest(COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST),
    },
    effectiveGrants: [],
    hostSignalRoutes: [],
  },
] as const satisfies readonly OfficialPluginCatalogPolicy[];

export const OFFICIAL_PLUGIN_CATALOG = OFFICIAL_PLUGIN_POLICIES.map((policy) => officialPluginCatalogEntry(policy));
