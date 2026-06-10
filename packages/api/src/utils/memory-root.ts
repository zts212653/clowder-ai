import { resolve } from 'node:path';
import { findMonorepoRoot } from './monorepo-root.js';

export interface MemoryRepoPaths {
  repoRoot: string;
  docsRoot: string;
  markersDir: string;
}

export function resolveMemoryRepoPaths(
  start = process.cwd(),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MemoryRepoPaths {
  const repoRoot = findMonorepoRoot(start);
  const docsRoot = env.DOCS_ROOT ?? resolve(repoRoot, 'docs');

  return {
    repoRoot,
    docsRoot,
    markersDir: resolve(docsRoot, 'markers'),
  };
}
