import { resolve } from 'node:path';
import { findMonorepoRoot } from './monorepo-root.js';

export interface MemoryRepoPaths {
  repoRoot: string;
  knowledgeRoot: string;
  docsRoot: string;
  markersDir: string;
}

export function resolveMemoryRepoPaths(
  start = process.cwd(),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MemoryRepoPaths {
  const repoRoot = findMonorepoRoot(start);
  // Knowledge follows the authorized workspace; persistence remains at its existing runtime root.
  const knowledgeRoot = env.CAT_CAFE_WORKSPACE_ROOT ? resolve(env.CAT_CAFE_WORKSPACE_ROOT) : repoRoot;
  const docsRoot = env.DOCS_ROOT ?? resolve(knowledgeRoot, 'docs');

  return {
    repoRoot,
    knowledgeRoot,
    docsRoot,
    markersDir: resolve(docsRoot, 'markers'),
  };
}
