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

/** Safe git exec — returns trimmed stdout or empty string on failure. Suppresses stderr. */
function safeExec(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
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
    // Guard: skip if not a git repo or no commits yet (e.g. fresh git init / Docker download)
    const headCheck = safeExec('git', ['rev-parse', 'HEAD'], projectRoot);
    if (!headCheck) return { ok: true };

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
        const originBranch = safeExec('git', ['rev-parse', '--verify', `origin/${branch}`], projectRoot);
        if (originBranch) {
          unpushedShared = diffUnpushedShared(`origin/${branch}`, projectRoot);
        } else {
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
  } catch {
    // Git not available or other error — don't block
    return { ok: true };
  }
}
