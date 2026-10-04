import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TasteRepository {
  canonicalRoot(): string;
  canonicalRootAsync?(): Promise<string>;
  approvalLockKey(): string;
}

export interface PublishableTasteRepository extends TasteRepository {
  gitCheckoutRoot(): string;
}

interface GitWorktree {
  path: string;
  branch?: string;
}

function runGit(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  }).trim();
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
export class FileTasteRepository implements PublishableTasteRepository {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  canonicalRoot(): string {
    const repositoryRoot = runGit(this.projectRoot, ['rev-parse', '--show-toplevel']);
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mainWorktree = parseWorktrees(raw).find((worktree) => worktree.branch === 'refs/heads/main');

    if (!mainWorktree || !existsSync(mainWorktree.path)) {
      throw new Error(`Taste repository cannot find a checked-out refs/heads/main worktree from "${this.projectRoot}"`);
    }
    return resolve(mainWorktree.path);
  }

  async canonicalRootAsync(): Promise<string> {
    const { stdout: repositoryRoot } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: this.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: repositoryRoot.trim(),
      encoding: 'utf8',
      timeout: 5000,
    });
    const mainWorktree = parseWorktrees(stdout).find((worktree) => worktree.branch === 'refs/heads/main');
    if (!mainWorktree)
      throw new Error(`Taste repository cannot find a checked-out refs/heads/main worktree from "${this.projectRoot}"`);
    await access(mainWorktree.path);
    return resolve(mainWorktree.path);
  }

  gitCheckoutRoot(): string {
    return resolve(runGit(this.projectRoot, ['rev-parse', '--show-toplevel']));
  }

  approvalLockKey(): string {
    const checkoutRoot = this.gitCheckoutRoot();
    const commonDir = resolve(checkoutRoot, runGit(checkoutRoot, ['rev-parse', '--git-common-dir']));
    return join(commonDir, 'cat-cafe-taste-publication');
  }
}

/** Resolve afresh per operation; injected in-memory repositories remain compatible. */
export function resolveCanonicalTasteRoot(repository: TasteRepository): Promise<string> {
  return repository.canonicalRootAsync ? repository.canonicalRootAsync() : Promise.resolve(repository.canonicalRoot());
}
