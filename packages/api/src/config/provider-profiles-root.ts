import { realpath, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isUnderAllowedRoot } from '../utils/project-path.js';

function realpathSyncOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await new Promise<string>((resolvePath, reject) => {
      realpath(path, (err, resolved) => {
        if (err) reject(err);
        else resolvePath(resolved);
      });
    });
  } catch {
    return null;
  }
}

export function isAllowedProviderProfilesRoot(absPath: string): boolean {
  return isUnderAllowedRoot(absPath);
}

export async function listProviderProfilesProjectRoots(projectRoot: string): Promise<string[]> {
  return [await resolveProviderProfilesRoot(projectRoot)];
}

export async function resolveProviderProfilesRoot(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  return (await realpathOrNull(root)) ?? root;
}

export function resolveProviderProfilesRootSync(projectRoot: string): string {
  const root = resolve(projectRoot);
  return realpathSyncOrNull(root) ?? root;
}
