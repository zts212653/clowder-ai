import type { Capability, PluginManifest } from '@clowder-ai/plugin-contract';

export const PLUGIN_CONTRACT_VERSION = '0.1.0-beta.7' as const;

export function canonicalCapabilities(values: readonly Capability[]): Capability[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function requestedCapabilitiesForManifest(manifest: PluginManifest): Capability[] {
  return canonicalCapabilities(manifest.features.flatMap((feature) => [...feature.capabilities]));
}
