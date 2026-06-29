/**
 * #712: Unified project enumeration for cascade operations.
 *
 * All features that need to iterate "all projects" (MCP sync, skill sync,
 * drift detection, blockedCats inheritance) should use this single function
 * instead of independently querying GovernanceRegistry.
 *
 * Sources:
 *   1. GovernanceRegistry entries (explicitly registered external projects)
 *   2. Nested .cat-cafe/capabilities.json within catCafeRoot (thread-derived
 *      projects not in the registry, e.g. packages/api/.cat-cafe/)
 *
 * catCafeRoot itself is always excluded from the result — callers handle
 * it separately as the "main" project.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { GovernanceRegistry } from './governance-registry.js';

/**
 * Directories to skip during nested project scan.
 *
 * Only build artifacts / VCS internals that can never contain valid project
 * configs. Intentionally does NOT include 'test' / '__tests__' — thread-derived
 * projects can legitimately live under test directories, and validateProjectPath()
 * (the system's canonical path validator) accepts them. See PR #713 R3 review.
 */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage']);

/**
 * Safety-valve depth limit for nested project scan.
 *
 * NOT a semantic restriction — validateProjectPath() imposes no depth limit,
 * and neither does this scanner in practice. This constant exists solely to
 * prevent infinite traversal in pathological layouts (e.g. recursive symlinks
 * that escape the visitedDirs cycle detection). 20 is well beyond any
 * realistic monorepo nesting; SCAN_SKIP_DIRS handles the real performance
 * bounding by pruning node_modules/dist/.git subtrees.
 */
const SAFETY_MAX_DEPTH = 20;

/**
 * List all project paths that have project-scoped capabilities.json,
 * excluding catCafeRoot itself.
 *
 * @param catCafeRoot - The main Cat Cafe project root
 * @param opts.maxScanDepth - Max directory depth for nested scan (default: 20).
 *   This is a safety valve, not a semantic bound — validateProjectPath()
 *   imposes no depth limit, and this scanner should match that behavior.
 * @returns Deduplicated, validated project paths
 */
export async function listAllProjectPaths(catCafeRoot: string, opts?: { maxScanDepth?: number }): Promise<string[]> {
  const resolvedRoot = resolve(catCafeRoot);
  const seen = new Set([resolvedRoot]);
  const result: string[] = [];

  const addIfNew = async (path: string): Promise<void> => {
    const resolved = resolve(path);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      const s = await stat(path);
      if (!s.isDirectory()) return;
    } catch {
      return;
    }
    result.push(path);
  };

  // 1. Governance registry entries
  try {
    const entries = await new GovernanceRegistry(catCafeRoot).listAll();
    for (const entry of entries) await addIfNew(entry.projectPath);
  } catch {
    // Registry unavailable — continue with nested scan
  }

  // 2. Nested .cat-cafe/capabilities.json within catCafeRoot.
  //    visitedDirs tracks real paths of traversed directories to break
  //    symlink cycles (separate from `seen` which tracks project roots).
  const maxDepth = opts?.maxScanDepth ?? SAFETY_MAX_DEPTH;
  const visitedDirs = new Set<string>();
  await scanNestedProjects(catCafeRoot, maxDepth, seen, result, visitedDirs);

  return result;
}

async function scanNestedProjects(
  base: string,
  maxDepth: number,
  seen: Set<string>,
  out: string[],
  visitedDirs: Set<string>,
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) return;

  // Cycle detection: resolve symlinks to real path, skip if already visited.
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    return; // dangling symlink or inaccessible
  }
  if (visitedDirs.has(realBase)) return;
  visitedDirs.add(realBase);

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (SCAN_SKIP_DIRS.has(name)) continue;
    const child = join(base, name);
    if (name === '.cat-cafe') {
      // Found a .cat-cafe dir — the project root is its parent
      const projectRoot = dirname(child);
      const resolved = resolve(projectRoot);
      if (!seen.has(resolved)) {
        try {
          await stat(join(child, 'capabilities.json'));
          seen.add(resolved);
          out.push(projectRoot);
        } catch {
          // No capabilities.json — skip
        }
      }
    } else {
      await scanNestedProjects(child, maxDepth, seen, out, visitedDirs, depth + 1);
    }
  }
}
