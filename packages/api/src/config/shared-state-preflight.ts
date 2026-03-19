/**
 * Shared State Preflight Check
 *
 * Vendor-agnostic check: are there unpushed shared-state file commits?
 * Called from invoke-single-cat.ts before dispatching ANY cat (Claude/Codex/Gemini).
 *
 * Shared state files (must match .githooks/pre-commit + shared-rules.md §14):
 *   - docs/BACKLOG.md
 *   - cat-config.json
 */
import { execFileSync } from 'node:child_process';

const SHARED_STATE_PATTERN = /^(docs\/BACKLOG\.md|cat-config\.json)$/;

interface GitExecResult {
  ok: boolean;
  stdout: string;
  exitCode: number | null;
}

function gitExec(args: string[], cwd: string): GitExecResult {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      exitCode: 0,
    };
  } catch (error) {
    const exitCode =
      typeof error === 'object' && error !== null && 'status' in error
        ? ((error as { status?: number | null }).status ?? null)
        : null;
    return { ok: false, stdout: '', exitCode };
  }
}

/** Safe git exec — returns trimmed stdout or empty string on failure. */
function safeExec(cmd: string, args: string[], cwd: string): string {
  if (cmd !== 'git') return '';
  return gitExec(args, cwd).stdout;
}

export interface SharedStatePreflightResult {
  ok: boolean;
  unpushedFiles?: string[];
  uncommittedFiles?: string[];
}

/**
 * Return shared-state files that are in local commits ahead of `ref`.
 * Uses rev-list --count to avoid false positives when local is only behind ref
 * (git diff --name-only ref..HEAD is a tree diff, not a commit-range diff).
 */
function diffUnpushedShared(ref: string, cwd: string): string[] {
  const aheadCount = safeExec('git', ['rev-list', '--count', `${ref}..HEAD`], cwd);
  if (!aheadCount || aheadCount === '0') return [];
  const raw = safeExec('git', ['diff', '--name-only', `${ref}..HEAD`], cwd);
  if (!raw) return [];
  return raw.split('\n').filter((f: string) => f && SHARED_STATE_PATTERN.test(f));
}

export function checkSharedStatePreflight(projectRoot: string): SharedStatePreflightResult {
  try {
    const repoProbe = gitExec(['rev-parse', '--is-inside-work-tree'], projectRoot);
    const isGitRepo = repoProbe.ok && repoProbe.stdout === 'true';
    if (!isGitRepo) {
      console.info('[shared-state-preflight] skip git checks (non-git project root)', {
        projectRoot,
        exitCode: repoProbe.exitCode,
      });
      return { ok: true };
    }

    // Check uncommitted changes to shared state
    const uncommittedRaw = safeExec('git', ['diff', '--name-only'], projectRoot);
    const stagedRaw = safeExec('git', ['diff', '--cached', '--name-only'], projectRoot);

    const uncommittedShared = [...uncommittedRaw.split('\n'), ...stagedRaw.split('\n')].filter(
      (f: string) => f && SHARED_STATE_PATTERN.test(f),
    );

    // Check unpushed commits touching shared state
    let unpushedShared: string[] = [];
    const upstream = safeExec('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], projectRoot);
    if (upstream) {
      unpushedShared = diffUnpushedShared(upstream, projectRoot);
    } else {
      // No upstream — try origin/<branch>, then fall back to origin/main merge-base
      const branch = safeExec('git', ['branch', '--show-current'], projectRoot);
      if (branch) {
        const remoteBranch = safeExec('git', ['rev-parse', '--verify', `origin/${branch}`], projectRoot);
        if (remoteBranch) {
          unpushedShared = diffUnpushedShared(`origin/${branch}`, projectRoot);
        } else {
          // origin/<branch> doesn't exist (new branch) — fall back to merge-base with origin/main
          const mergeBase = safeExec('git', ['merge-base', 'HEAD', 'origin/main'], projectRoot);
          if (mergeBase) {
            unpushedShared = diffUnpushedShared(mergeBase, projectRoot);
          }
        } 
      }
    }

    const hasIssue = uncommittedShared.length > 0 || unpushedShared.length > 0;
    return {
      ok: !hasIssue,
      ...(uncommittedShared.length > 0 ? { uncommittedFiles: [...new Set(uncommittedShared)] } : {}),
      ...(unpushedShared.length > 0 ? { unpushedFiles: [...new Set(unpushedShared)] } : {}),
    };
  } catch (error) {
    console.warn('[shared-state-preflight] fail-open on internal preflight error', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Git not available or other error — don't block
    return { ok: true };
  }
}
