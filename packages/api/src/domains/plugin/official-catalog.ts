import type { MeetingIntakeJudgmentField } from '@cat-cafe/shared';
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
    version: release.version,
    archiveUrl: release.archiveUrl,
    packageDigest: release.packageDigest,
    effectiveGrants: policy.effectiveGrants,
    ...(policy.ownerAuth === undefined ? {} : { ownerAuth: policy.ownerAuth }),
  };
}

export const OFFICIAL_PLUGIN_POLICIES = [
  {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    pluginId: 'official.feishu-meeting-intake',
    releaseTag: 'next',
    bootstrapRelease: {
      version: '0.1.0-alpha.8',
      archiveUrl:
        'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.8.tgz',
      packageDigest: 'sha512-unl8sq1rEMckgiqE8mI0e0+Qa6l69J4cxT2GOe5AMUSomkrbmpKdZR/EYljvH+hP4tNaR9l1KQd6T9GWX49L4w==',
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
] as const satisfies readonly OfficialPluginCatalogPolicy[];

export const OFFICIAL_PLUGIN_CATALOG = OFFICIAL_PLUGIN_POLICIES.map((policy) => officialPluginCatalogEntry(policy));
