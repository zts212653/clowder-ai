import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { WorkspaceSecurityError } from './workspace-security-error.js';

/** Canonicalize existing ancestors while retaining the missing suffix for the original root fence. */
export async function canonicalWorkspacePath(candidate: string): Promise<string> {
  let ancestor = resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entry = await lstat(ancestor).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== 'ENOENT') throw failure;
        return null;
      });
      if (entry?.isSymbolicLink())
        throw new WorkspaceSecurityError('Cannot verify a dangling workspace symlink', 'DENIED');
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
