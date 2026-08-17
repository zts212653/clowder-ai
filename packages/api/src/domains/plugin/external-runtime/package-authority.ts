import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackage } from './types.js';

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function rejectSymlinkComponents(rootDir: string, entrypoint: string): Promise<void> {
  const segments = entrypoint.split(/[\\/]+/).filter(Boolean);
  let current = rootDir;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint path may not contain symlinks');
    }
  }
}

export async function verifyExternalPackage(
  packageRecord: PluginPackageRecord,
  located: VerifiedPluginPackage,
): Promise<{ readonly rootDir: string; readonly entrypoint: string }> {
  if (!isDeepStrictEqual(located.manifest, packageRecord.manifest)) {
    throw new ExternalPluginRuntimeError(
      'PACKAGE_AUTHORITY_MISMATCH',
      'located package manifest differs from the admitted package record',
    );
  }
  if (packageRecord.manifest.runtime.transport !== 'stdio') {
    throw new ExternalPluginRuntimeError(
      'UNSUPPORTED_TRANSPORT',
      `runtime transport ${packageRecord.manifest.runtime.transport} is not executable by the stdio Host`,
    );
  }
  const rootDir = resolve(located.rootDir);
  let rootStat: Stats;
  try {
    rootStat = await lstat(rootDir);
  } catch (error) {
    throw new ExternalPluginRuntimeError('INVALID_PACKAGE_ROOT', 'plugin package root is unavailable', {
      cause: error,
    });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ExternalPluginRuntimeError('INVALID_PACKAGE_ROOT', 'plugin package root must be a real directory');
  }
  const declared = packageRecord.manifest.runtime.entrypoint;
  if (isAbsolute(declared)) {
    throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint must be package-relative');
  }
  const entrypoint = resolve(rootDir, declared);
  if (!isContained(rootDir, entrypoint)) {
    throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint escapes the admitted package root');
  }
  try {
    await rejectSymlinkComponents(rootDir, declared);
    const entryStat = await lstat(entrypoint);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint must be a regular file');
    }
    const [realRoot, realEntry] = await Promise.all([realpath(rootDir), realpath(entrypoint)]);
    if (!isContained(realRoot, realEntry)) {
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint resolves outside the package root');
    }
  } catch (error) {
    if (error instanceof ExternalPluginRuntimeError) throw error;
    throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'plugin entrypoint is unavailable', { cause: error });
  }
  await located.verifyIntegrity();
  return { rootDir, entrypoint };
}
