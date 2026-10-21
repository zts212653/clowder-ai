import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import {
  DATA_DIRECTORY_NAME,
  type DataDirectoryManifest,
  isHostReservedDataDirectoryName,
  requestedDataDirectoryName,
} from '../host-inventory/data-directory-name.js';
import { pluginHostRoot } from '../host-inventory/plugin-host-layout.js';

/** The parent of every module plugin data directory: the Host's plugin-host root. */
export function pluginDataDirectoryParent(projectRoot: string): string {
  return pluginHostRoot(projectRoot);
}

/** Prepares the stable declared module directory without a separate capability grant.
 * Owner data survives stop/uninstall; the existing name and collision rules remain unchanged. */
export async function preparePluginDataDirectory(input: {
  readonly parent: string | undefined;
  readonly manifest: DataDirectoryManifest;
  readonly effectiveGrants: readonly string[];
}): Promise<string> {
  if (input.parent === undefined)
    throw new ExternalPluginRuntimeError('DATA_DIRECTORY_UNAVAILABLE', 'Host data directory parent is not configured');
  const name = requestedDataDirectoryName(input.manifest);
  if (name === undefined)
    throw new ExternalPluginRuntimeError('DATA_DIRECTORY_UNAVAILABLE', 'Package has no module data directory');
  const directory = join(input.parent, name);
  const unavailable = (why: string, cause?: unknown) =>
    new ExternalPluginRuntimeError(
      'DATA_DIRECTORY_UNAVAILABLE',
      `${input.manifest.pluginId} data directory ${directory} ${why}`,
      cause === undefined ? undefined : { cause },
    );
  if (!DATA_DIRECTORY_NAME.test(name) || isHostReservedDataDirectoryName(name)) {
    throw unavailable('has an invalid or Host-reserved name');
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unavailable('cannot be created', error);
  }
  const entry = await lstat(directory);
  if (!entry.isDirectory()) throw unavailable('is not a directory');
  await chmod(directory, 0o700);
  return directory;
}
