import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContentEditorProviderContribution } from '@clowder-ai/plugin-contract';
import { readBoundedPackageFile } from '../external-runtime/bounded-package-file.js';
import type { VerifiedPluginPackage } from '../external-runtime/types.js';

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function snapshotEditorAssets(
  pkg: VerifiedPluginPackage,
  contributions: readonly ContentEditorProviderContribution[],
): Promise<ReadonlyMap<string, Buffer>> {
  await pkg.verifyIntegrity();
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  async function walk(directory: string): Promise<void> {
    if (!contained(pkg.rootDir, directory)) throw new Error('surface path escapes package');
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('surface root is not a physical directory');
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new Error('surface contains a symlink');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const key = relative(pkg.rootDir, path).split(sep).join('/');
        if (files.has(key)) continue;
        totalBytes += entry.size;
        if (totalBytes > 128 * 1024 * 1024 || files.size >= 4096) throw new Error('surface asset budget exceeded');
        files.set(key, await readBoundedPackageFile(pkg.rootDir, key, entry.size));
      } else throw new Error('surface contains a non-regular file');
    }
  }
  for (const contribution of contributions) {
    const entrypoint = contribution.surface.entrypoint;
    if (!/^[A-Za-z0-9._~-]+\/[A-Za-z0-9._~/-]+\.html$/.test(entrypoint) || entrypoint.split('/').includes('..')) {
      throw new Error('surface requires a package-local asset directory');
    }
    await walk(dirname(resolve(pkg.rootDir, entrypoint)));
    const bytes = files.get(entrypoint);
    if (!bytes || `sha256-${createHash('sha256').update(bytes).digest('base64')}` !== contribution.surface.integrity) {
      throw new Error('surface integrity mismatch');
    }
  }
  await pkg.verifyIntegrity();
  return files;
}
