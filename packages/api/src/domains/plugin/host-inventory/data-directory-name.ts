import { createHash } from 'node:crypto';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { isHostPluginHostEntry } from './plugin-host-layout.js';

/**
 * F202 W2-3 h2: which data directory name a package can be given (contract beta.24
 * `runtime.dataDirectory`, capability `data.directory`). The inventory uses it to keep two
 * installed plugins off one directory; the module runtime uses it to create the directory.
 */
export const DATA_DIRECTORY_CAPABILITY = 'data.directory';

/** Single path segment; the pattern already excludes `.` and `..`. Same as the contract's. */
export const DATA_DIRECTORY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The Host keeps its own state in the same parent (`.cat-cafe/plugin-host`), so a plugin can never
 * be given the name of one of the Host's entries there, declared or derived. The table of those
 * entries is the single truth (plugin-host-layout.ts).
 */
export function isHostReservedDataDirectoryName(name: string): boolean {
  return isHostPluginHostEntry(name);
}

export type DataDirectoryManifest = Pick<PluginManifest, 'pluginId' | 'runtime' | 'features'>;

/**
 * The name of the directory a package can be given, or undefined when it can never get one (it is
 * not a module, or it does not request `data.directory`). The name is the declared
 * `runtime.dataDirectory`; without one, the plugin id when that already is a valid name, and
 * otherwise `plugin-` followed by 16 hex digits of the id's sha256.
 */
export function requestedDataDirectoryName(manifest: DataDirectoryManifest): string | undefined {
  const runtime = manifest.runtime;
  if (runtime?.transport !== 'builtin') return undefined;
  const requested = manifest.features.some((feature) => feature.capabilities.includes(DATA_DIRECTORY_CAPABILITY));
  if (!requested) return undefined;
  if (runtime.dataDirectory !== undefined) return runtime.dataDirectory;
  if (DATA_DIRECTORY_NAME.test(manifest.pluginId)) return manifest.pluginId;
  return `plugin-${createHash('sha256').update(manifest.pluginId).digest('hex').slice(0, 16)}`;
}
