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

/**
 * Resolve the module a package declares, against the manifest the Host admitted.
 *
 * Carrier-neutral by construction (F202 Train C1 clause 1): every carrier that runs
 * package-supplied code — a child process speaking the broker protocol, or a module
 * loaded inside the Host — resolves its entrypoint here. Which transports a carrier
 * runs is that carrier's own claim, asserted before it reaches this function; restating
 * it here would put a carrier branch back inside the shared authority.
 *
 * It sits under `external-runtime/` because that directory already holds the Host's
 * shared package vocabulary (`VerifiedPluginPackage`, `ExternalPluginRuntimeError`).
 * The directory name predates carrier neutrality; renaming it is its own change.
 *
 * Scope: entrypoint authority only. Byte integrity is deliberately NOT verified here,
 * because the two carriers need that check at different instants and only the carrier
 * knows its own instant. The child-process carrier re-snapshots AFTER it has projected
 * `starting`, so a tree mutated inside the projection window still cannot reach spawn
 * (`supervisor.ts`, pinned by "rechecks the staged tree after runtime-state projection").
 * The module carrier snapshots immediately before `import()`. Verifying here too would
 * add a second full-tree snapshot per child start that catches nothing the carrier's own
 * later check would miss.
 */
export async function verifyPackageEntrypoint(
  packageRecord: PluginPackageRecord,
  located: VerifiedPluginPackage,
): Promise<{ readonly rootDir: string; readonly entrypoint: string }> {
  if (!isDeepStrictEqual(located.manifest, packageRecord.manifest)) {
    throw new ExternalPluginRuntimeError(
      'PACKAGE_AUTHORITY_MISMATCH',
      'located package manifest differs from the admitted package record',
    );
  }
  const declared = packageRecord.manifest.runtime?.entrypoint;
  if (declared === undefined) {
    throw new ExternalPluginRuntimeError(
      'INVALID_ENTRYPOINT',
      `${packageRecord.pluginId} declares no runtime entrypoint to load`,
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
  return { rootDir, entrypoint };
}
