import {
  type Capability,
  type PluginManifest,
  validateEffectiveGrants,
  validateManifest,
} from '@clowder-ai/plugin-contract';

/** Exact npm package consumed by this Host build. */
export const PLUGIN_CONTRACT_PACKAGE_VERSION = '0.1.0-beta.15' as const;
/** Manifest compatibility line declared by admitted plugins. */
export const PLUGIN_CONTRACT_VERSION = '0.1.0' as const;
/** Published Train B packages still declare this beta manifest line. */
export const PUBLISHED_PLUGIN_MANIFEST_CONTRACT_VERSION = '0.1.0-beta.13' as const;
/** Exact manifest contract versions admitted during the beta-to-stable migration. */
export const PLUGIN_MANIFEST_CONTRACT_VERSIONS = [
  PLUGIN_CONTRACT_VERSION,
  PUBLISHED_PLUGIN_MANIFEST_CONTRACT_VERSION,
  PLUGIN_CONTRACT_PACKAGE_VERSION,
] as const;

export const DEFAULT_PLUGIN_CONTRACT_RUNTIME = {
  manifestContractVersions: PLUGIN_MANIFEST_CONTRACT_VERSIONS,
  validateManifest,
  validateEffectiveGrants,
};

export function canonicalCapabilities(values: readonly Capability[]): Capability[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function requestedCapabilitiesForManifest(manifest: PluginManifest): Capability[] {
  return canonicalCapabilities(manifest.features.flatMap((feature) => [...feature.capabilities]));
}
