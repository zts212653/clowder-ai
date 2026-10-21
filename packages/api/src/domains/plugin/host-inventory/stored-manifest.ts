import { type PluginManifest, validatePluginId } from '@clowder-ai/plugin-contract';
import type { PluginPackageRecord } from './types.js';
import { PluginInventoryError } from './types.js';

/** Stable storage envelope, not an older executable contract. Unknown fields survive unchanged. */
export interface StoredPluginManifest extends Readonly<Record<string, unknown>> {
  readonly pluginId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly name: string;
  readonly features: readonly {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly string[];
  }[];
  readonly runtime?: { readonly transport: string; readonly dataDirectory?: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function storedManifest(value: unknown, label: string): StoredPluginManifest {
  if (
    !record(value) ||
    !['pluginId', 'version', 'contractVersion', 'name'].every((key) => text(value[key])) ||
    !validatePluginId(value.pluginId) ||
    !Array.isArray(value.features) ||
    value.features.some(
      (feature) =>
        !record(feature) ||
        !text(feature.id) ||
        !text(feature.name) ||
        !Array.isArray(feature.capabilities) ||
        feature.capabilities.some((capability) => !text(capability)) ||
        new Set(feature.capabilities).size !== feature.capabilities.length,
    ) ||
    (value.runtime !== undefined &&
      (!record(value.runtime) ||
        !text(value.runtime.transport) ||
        (value.runtime.dataDirectory !== undefined &&
          (typeof value.runtime.dataDirectory !== 'string' ||
            !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.runtime.dataDirectory)))))
  ) {
    throw new PluginInventoryError('CORRUPT_SNAPSHOT', `${label} has an invalid stored manifest envelope`);
  }
  return structuredClone(value) as StoredPluginManifest;
}

export function requireExecutableManifest(record: PluginPackageRecord): PluginManifest {
  if (record.manifest === null) {
    throw new PluginInventoryError('INCOMPATIBLE_PACKAGE', 'Plugin version is incompatible; update or reinstall it');
  }
  return record.manifest;
}

/** Disk format stays unchanged. Compatibility is recomputed by each Host, never trusted from disk. */
export function serializeInventoryPackage(record: PluginPackageRecord): Record<string, unknown> {
  const { incompatibleManifest, ...rest } = record;
  return { ...rest, manifest: record.manifest ?? incompatibleManifest };
}

export function assertExecutablePackage(
  record: PluginPackageRecord,
): asserts record is import('./types.js').ExecutablePluginPackageRecord {
  requireExecutableManifest(record);
}
