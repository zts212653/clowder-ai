import { createRequire } from 'node:module';
import { type Capability, type PluginManifest, validateEffectiveGrants } from '@clowder-ai/plugin-contract';
import { validateHostPluginManifest } from '../desktop-window-runtime/presentation-manifest.js';

/** Exact npm package consumed by this Host build. */
export const PLUGIN_CONTRACT_PACKAGE_VERSION = '0.2.0' as const;
/** Baseline manifest protocol; independent of the SDK and contract npm package releases. */
export const PLUGIN_CONTRACT_VERSION = '0.1.0' as const;
/**
 * The earliest supported historical protocol through the version this Host implements.
 * Advancing the package alone never rewrites a plugin's declared requirement.
 * A breaking protocol change must explicitly narrow this compatibility range.
 */
export const PLUGIN_MANIFEST_CONTRACT_RANGE = `>=0.1.0-beta.13 <=${PLUGIN_CONTRACT_PACKAGE_VERSION}`;

// This is the API's direct locked dependency, not an npm-internal or hoisted copy.
const semver = createRequire(import.meta.url)('semver') as {
  satisfies(version: string, range: string, options: { includePrerelease: boolean }): boolean;
};

export function isManifestContractSupported(version: string, range: string): boolean {
  // Historical beta declarations are part of the supported protocol interval.
  // They still have to satisfy both bounds; future prereleases are not enabled globally.
  return semver.satisfies(version, range, { includePrerelease: true });
}

export const DEFAULT_PLUGIN_CONTRACT_RUNTIME = {
  manifestContractRange: PLUGIN_MANIFEST_CONTRACT_RANGE,
  validateManifest: validateHostPluginManifest,
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
