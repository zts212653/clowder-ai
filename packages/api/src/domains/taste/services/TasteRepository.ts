import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface TasteRepository {
  canonicalRoot(): string;
  approvalLockKey(): string;
}

interface GitWorktree {
  path: string;
  branch?: string;
}

function runGit(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseWorktrees(raw: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;

  for (const field of raw.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: field.slice('worktree '.length) };
    } else if (field.startsWith('branch ') && current) {
      current.branch = field.slice('branch '.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/**
 * Canonical F221 Taste repository.
 *
 * Public Taste remains Git-tracked, so its durable root is the worktree that
 * actually owns refs/heads/main in the same Git repository. Runtime/workspace
 * environment roots are intentionally not consulted: production may point both
 * at runtime/main-sync, and neither variable is a canonical-main locator.
 */
export class FileTasteRepository implements TasteRepository {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  canonicalRoot(): string {
    const repositoryRoot = runGit(this.projectRoot, ['rev-parse', '--show-toplevel']);
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mainWorktree = parseWorktrees(raw).find((worktree) => worktree.branch === 'refs/heads/main');

    if (!mainWorktree || !existsSync(mainWorktree.path)) {
      throw new Error(`Taste repository cannot find a checked-out refs/heads/main worktree from "${this.projectRoot}"`);
    }
    return resolve(mainWorktree.path);
  }

  approvalLockKey(): string {
    return join(this.canonicalRoot(), 'docs/taste/index.md');
  }
}
