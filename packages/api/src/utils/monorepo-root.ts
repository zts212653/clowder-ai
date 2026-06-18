import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Process-lifetime caches for filesystem-resolved paths (#950).
 *
 * These paths (monorepo root, git common dir) do not change during process
 * lifetime, so caching avoids repeated synchronous I/O that blocks the Node
 * event loop — especially painful on Windows + HDD where each stat/readFile
 * can take 5-50ms per seek.
 *
 * Windows NTFS is case-insensitive so cache keys are lowercased on win32.
 */
const _isWin = process.platform === 'win32';
function cacheKey(p: string): string {
  const resolved = resolve(p);
  return _isWin ? resolved.toLowerCase() : resolved;
}

type MonorepoRootCacheEntry = {
  root: string;
  /**
   * Workspace hits are safe to reuse for descendants/ancestors in the traversal
   * trail. Fallback hits are exact-start only because "no workspace found"
   * returns the original start directory by contract.
   */
  shared: boolean;
};

const _monorepoRootCache = new Map<string, MonorepoRootCacheEntry>();

export function findMonorepoRoot(start = process.cwd()): string {
  const startKey = cacheKey(start);
  const cached = _monorepoRootCache.get(startKey);
  if (cached !== undefined) return cached.root;

  const trail: string[] = [];
  let dir = resolve(start);
  let root: string | null = null;

  while (dir !== dirname(dir)) {
    const dirKey = cacheKey(dir);
    const dirCached = _monorepoRootCache.get(dirKey);
    if (dirCached?.shared) {
      root = dirCached.root;
      break;
    }
    trail.push(dirKey);
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      root = dir;
      break;
    }
    dir = dirname(dir);
  }

  const result = root ?? resolve(start);
  if (root) {
    const entry: MonorepoRootCacheEntry = { root: result, shared: true };
    // Memoize all directories we traversed — they all share the same workspace root.
    _monorepoRootCache.set(startKey, entry);
    for (const key of trail) {
      _monorepoRootCache.set(key, entry);
    }
  } else {
    _monorepoRootCache.set(startKey, { root: result, shared: false });
  }
  return result;
}

/**
 * Resolve the git common directory for a project path.
 * Handles both regular repos (.git is a directory) and
 * worktrees (.git is a file pointing to the main repo).
 */
const _gitCommonDirCache = new Map<string, string | null>();

function resolveGitCommonDir(projectPath: string): string | null {
  const key = cacheKey(projectPath);
  if (_gitCommonDirCache.has(key)) return _gitCommonDirCache.get(key)!;

  const gitPath = join(projectPath, '.git');
  let result: string | null = null;
  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) {
      result = resolve(gitPath);
    } else {
      // Worktree: .git file contains "gitdir: <path>/worktrees/<name>"
      const content = readFileSync(gitPath, 'utf-8').trim();
      const m = content.match(/^gitdir:\s*(.+)/);
      if (m) {
        const gitdir = resolve(projectPath, m[1]!);
        // .git/worktrees/<name> → .git
        result = resolve(gitdir, '..', '..');
      }
    }
  } catch {
    // No .git found — result stays null
  }

  _gitCommonDirCache.set(key, result);
  return result;
}

/** Check if two paths belong to the same git project (handles worktrees). */
export function isSameProject(pathA: string, pathB: string): boolean {
  if (resolve(pathA) === resolve(pathB)) return true;
  const dirA = resolveGitCommonDir(pathA);
  const dirB = resolveGitCommonDir(pathB);
  return dirA !== null && dirA === dirB;
}

/** @internal — exposed only for testing. */
export function _clearCachesForTest(): void {
  _monorepoRootCache.clear();
  _gitCommonDirCache.clear();
}
