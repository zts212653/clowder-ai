import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function gitCommonDir(dir: string): string | null {
  try {
    const d = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return realpathSync(resolve(dir, d));
  } catch {
    return null;
  }
}

let cachedRepoGitDir: string | null | undefined;

export function initRepoIdentity(repoRoot: string): void {
  cachedRepoGitDir = gitCommonDir(repoRoot);
}

export function isSameRepo(projectPath: string, repoRoot: string): boolean {
  if (resolve(projectPath) === resolve(repoRoot)) return true;
  if (cachedRepoGitDir === undefined) initRepoIdentity(repoRoot);
  if (!cachedRepoGitDir) return false;

  const projGitDir = gitCommonDir(projectPath);
  return projGitDir !== null && projGitDir === cachedRepoGitDir;
}
