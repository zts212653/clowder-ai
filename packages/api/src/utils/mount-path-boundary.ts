import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isPathUnderRoots } from './project-path.js';

/** Reconstruct missing descendants through their nearest existing physical ancestor. */
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if ((error.code !== 'ENOENT' && error.code !== 'ENOTDIR') || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  });
}

/**
 * Return the physical mutation path when it escapes the configured project.
 * A terminal link is a node to unlink/rename or reject; callers must not write through it.
 * Ancestor links are always followed, including when the destination does not exist yet.
 */
export async function resolveMountBoundaryEscape(projectRoot: string, path: string): Promise<string | null> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return null;
  });
  const [root, destination] = await Promise.all([
    canonicalPath(resolve(projectRoot)),
    canonicalPath(resolve(stat?.isSymbolicLink() ? dirname(path) : path)),
  ]);
  return isPathUnderRoots(destination, [root]) ? null : destination;
}
