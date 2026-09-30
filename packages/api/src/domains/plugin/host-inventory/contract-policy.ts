import {
  type Capability,
  type PluginManifest,
  validateEffectiveGrants,
  validateManifest,
} from '@clowder-ai/plugin-contract';

/** Exact npm package consumed by this Host build. */
export const PLUGIN_CONTRACT_PACKAGE_VERSION = '0.1.0-beta.25' as const;
/** Manifest compatibility line declared by admitted plugins. */
export const PLUGIN_CONTRACT_VERSION = '0.1.0' as const;
/** Published Train B packages still declare this beta manifest line. */
export const PUBLISHED_PLUGIN_MANIFEST_CONTRACT_VERSION = '0.1.0-beta.13' as const;
/**
 * Train C1 packages already admitted under earlier beta lines remain installed (beta.20, beta.21,
 * beta.22, beta.24). The Host never consumed beta.23 (a version-only sync), so no manifest declares
 * it here.
 */
export const PREVIOUS_PLUGIN_MANIFEST_CONTRACT_VERSIONS = [
  '0.1.0-beta.20',
  '0.1.0-beta.21',
  '0.1.0-beta.22',
  '0.1.0-beta.24',
] as const;
/** Exact manifest contract versions admitted during the beta-to-stable migration. */
export const PLUGIN_MANIFEST_CONTRACT_VERSIONS = [
  PLUGIN_CONTRACT_VERSION,
  PUBLISHED_PLUGIN_MANIFEST_CONTRACT_VERSION,
  ...PREVIOUS_PLUGIN_MANIFEST_CONTRACT_VERSIONS,
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

export function requestedCapabilitiesForManifest(manifest: Pick<PluginManifest, 'features'>): Capability[] {
  return canonicalCapabilities(manifest.features.flatMap((feature) => [...feature.capabilities]));
}

/**
 * F202 W2-6: what a package is granted — what it requests, within the Host's upper bound. A package
 * asking for less than the bound gets less (and still installs); asking for more gets no more.
 */
export function grantsWithinRequest(
  upperBound: readonly Capability[],
  manifest: Pick<PluginManifest, 'features'>,
): Capability[] {
  const allowed = new Set(upperBound);
  return requestedCapabilitiesForManifest(manifest).filter((capability) => allowed.has(capability));
}
