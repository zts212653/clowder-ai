import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findMonorepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(start);
}

/**
 * Resolve the git common directory for a project path.
 * Handles both regular repos (.git is a directory) and
 * worktrees (.git is a file pointing to the main repo).
 */
export function resolveGitCommonDir(projectPath: string): string | null {
  const gitPath = join(projectPath, '.git');
  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return resolve(gitPath);
    // Worktree: .git file contains "gitdir: <path>/worktrees/<name>"
    const content = readFileSync(gitPath, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+?)\s*$/);
    if (!m) return null;
    const gitdir = resolve(projectPath, m[1]!);
    // Prefer the authoritative commondir file over depth heuristic
    const commondirFile = join(gitdir, 'commondir');
    try {
      const commondir = readFileSync(commondirFile, 'utf-8').trim();
      return resolve(gitdir, commondir);
    } catch {
      // Fallback: .git/worktrees/<name> → .git
      return resolve(gitdir, '..', '..');
    }
  } catch {
    return null;
  }
}

/** Check if two paths belong to the same git project (handles worktrees). */
export function isSameProject(pathA: string, pathB: string): boolean {
  if (resolve(pathA) === resolve(pathB)) return true;
  const dirA = resolveGitCommonDir(pathA);
  const dirB = resolveGitCommonDir(pathB);
  return dirA !== null && dirA === dirB;
}
