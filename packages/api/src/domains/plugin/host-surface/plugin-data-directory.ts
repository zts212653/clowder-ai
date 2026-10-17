import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import {
  DATA_DIRECTORY_CAPABILITY,
  DATA_DIRECTORY_NAME,
  type DataDirectoryManifest,
  isHostReservedDataDirectoryName,
  requestedDataDirectoryName,
} from '../host-inventory/data-directory-name.js';
import { pluginHostRoot } from '../host-inventory/plugin-host-layout.js';

/**
 * F202 W2-3 h2: a module plugin's disk data directory (contract beta.24 `runtime.dataDirectory`,
 * capability `data.directory`).
 *
 * It is `<projectRoot>/.cat-cafe/plugin-host/<name>`, created 0700 before the module starts, and
 * only a package granted `data.directory` receives it. Two installed plugins never share one name
 * (the inventory refuses the second), and uninstall keeps the directory: it is the owner's data.
 */

/** The parent of every module plugin data directory: the Host's plugin-host root. */
export function pluginDataDirectoryParent(projectRoot: string): string {
  return pluginHostRoot(projectRoot);
}

/**
 * Creates the package's data directory (0700) when the package holds the grant, and returns its
 * absolute path. Without the grant, or without a parent (a Host composed without data
 * directories), it creates nothing and returns undefined. Anything but a real directory at that
 * path (a file, a symbolic link) fails closed before the module starts.
 */
export async function preparePluginDataDirectory(input: {
  readonly parent: string | undefined;
  readonly manifest: DataDirectoryManifest;
  readonly effectiveGrants: readonly string[];
}): Promise<string | undefined> {
  if (input.parent === undefined || !input.effectiveGrants.includes(DATA_DIRECTORY_CAPABILITY)) return undefined;
  const name = requestedDataDirectoryName(input.manifest);
  if (name === undefined) return undefined;
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
