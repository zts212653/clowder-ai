/**
 * F140 Phase C: Auto-executor for PR merge conflicts.
 *
 * Clean rebase → push automatically. Any conflict → abort + escalate with file list.
 * Safety: only feat/* branches, never main/runtime, --force-with-lease, 30s timeout.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { listWorktrees } from '../../domains/workspace/workspace-security.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;

export type AutoResolveResult =
  | { kind: 'resolved'; method: 'clean-rebase'; branch: string }
  | { kind: 'escalated'; files: string[]; branch: string }
  | { kind: 'skipped'; reason: string };

export interface ConflictAutoExecutorOptions {
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly repoRoot?: string;
}

export class ConflictAutoExecutor {
  constructor(private readonly opts: ConflictAutoExecutorOptions) {}

  async resolve(repoFullName: string, prNumber: number): Promise<AutoResolveResult> {
    const { log } = this.opts;

    // 1. Get PR head branch from GitHub
    const branch = await this.getPrBranch(repoFullName, prNumber);
    if (!branch) return { kind: 'skipped', reason: 'cannot determine PR branch' };

    // Safety: only feat/* branches
    if (!branch.startsWith('feat/')) {
      return { kind: 'skipped', reason: `branch ${branch} is not feat/* — refusing auto-rebase` };
    }

    // 2. Find local worktree for this branch
    const worktreePath = await this.findWorktree(branch);
    if (!worktreePath) return { kind: 'skipped', reason: `no local worktree for branch ${branch}` };

    // Safety: never touch runtime
    if (worktreePath.includes('-runtime')) {
      return { kind: 'skipped', reason: 'refusing to touch runtime worktree' };
    }

    log.info(`[ConflictAutoExecutor] Attempting auto-rebase for ${branch} in ${worktreePath}`);

    // 3. Fetch + rebase
    try {
      await this.git(worktreePath, ['fetch', 'origin', 'main']);
      await this.git(worktreePath, ['rebase', 'origin/main']);
    } catch {
      return this.handleRebaseFailure(worktreePath, branch);
    }

    // 4. Clean rebase succeeded → push
    try {
      await this.git(worktreePath, ['push', '--force-with-lease']);
      log.info(`[ConflictAutoExecutor] Clean rebase + push succeeded for ${branch}`);
      return { kind: 'resolved', method: 'clean-rebase', branch };
    } catch {
      // Push rejected (e.g. someone else pushed) — don't escalate, just skip
      return { kind: 'skipped', reason: 'push --force-with-lease rejected' };
    }
  }

  private async handleRebaseFailure(worktreePath: string, branch: string): Promise<AutoResolveResult> {
    const { log } = this.opts;
    let conflictFiles: string[] = [];

    try {
      const { stdout } = await this.git(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
      conflictFiles = stdout.trim().split('\n').filter(Boolean);
    } catch {
      // Can't even list conflicts
    }

    // Always abort
    await this.git(worktreePath, ['rebase', '--abort']).catch(() => {});

    if (conflictFiles.length === 0) {
      log.warn(`[ConflictAutoExecutor] Rebase failed but no conflict files found for ${branch}`);
      return { kind: 'skipped', reason: 'rebase failed without identifiable conflicts' };
    }

    log.info(`[ConflictAutoExecutor] Escalating: ${conflictFiles.length} conflict file(s) in ${branch}`);
    return { kind: 'escalated', files: conflictFiles, branch };
  }

  async getPrBranch(repoFullName: string, prNumber: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repoFullName}/pulls/${prNumber}`, '--jq', '.head.ref'],
        { timeout: GH_TIMEOUT_MS },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async findWorktree(branch: string): Promise<string | null> {
    try {
      const entries = await listWorktrees(this.opts.repoRoot);
      return entries.find((e) => e.branch === branch)?.root ?? null;
    } catch {
      return null;
    }
  }

  private git(cwd: string, args: string[]) {
    return execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  }
}
