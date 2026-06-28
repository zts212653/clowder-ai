#!/usr/bin/env node
/**
 * LL-082 hard layer: dirty-worktree ledger.
 *
 * Background (LL-082 / H4 dogfood failure): pre-merge-check.sh checks only the CURRENT
 * worktree's uncommitted changes. The H4 incident was a real cross-post-alias fix left
 * dirty in ANOTHER worktree (cat-cafe-f233-pr3-cloudfix) that crossed merge-gate unnoticed —
 * the author's own LL-082 lesson got violated the same day because the soft layer (skill
 * docs + memory) didn't catch a sibling-worktree dirty diff.
 *
 * This guard lists ALL git worktrees and flags any with uncommitted changes, so each dirty
 * diff must have a known PR/task/comment provenance before merge. Warn-level (exit 0): a
 * dirty worktree may be legitimate WIP — the point is VISIBILITY at merge time, not blocking.
 *
 * Wired into pre-merge-check.sh merge-gate finish (ADR-031 hard layer for LL-082).
 *
 * Output contract (stable for tests):
 *   - clean:  prints "[dirty-ledger] OK" and exits 0
 *   - dirty:  prints "[dirty-ledger] WARN" header + one line per dirty worktree, exits 0
 *
 * Absolute `git -C <path>` everywhere — never relies on CWD (LL-049 drift defense).
 */
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fixed-command runner (no untrusted input): `git rev-parse` / `git worktree list`.
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/**
 * Sentinel returned by gitStatusPorcelain when the underlying `git status` exec
 * fails (oversized output past maxBuffer, missing git, file system error, etc.).
 * The ledger must distinguish "exec failed -> status unknown" from "exec returned
 * empty -> definitely clean", otherwise an oversized dirty worktree would be
 * silently suppressed as clean — same silent-disable hazard as R3.
 */
export const STATUS_CHECK_FAILED_SENTINEL = '__LL082_STATUS_CHECK_FAILED__';

/**
 * P2 fix (cloud review R1): a worktree path is UNTRUSTED input — it can contain
 * shell metacharacters (`$`, backticks, quotes). Run `git status` via exec ARGS,
 * not an interpolated shell string, so the path can never be rewritten/executed
 * by the shell (and `run()`'s error-swallowing can't silently mask an injected
 * path). `exec` is injectable for tests.
 *
 * P2 fix (cloud review R4): two layers of defense against false-clean ledger:
 *   1. `maxBuffer: 50MB` — covers normal sibling worktrees with many untracked
 *      files (e.g. an uncommitted dist/, build artifacts); default 1MB easily
 *      overflows on real workspaces.
 *   2. On any exec failure (buffer exceeded, git missing, fs error) return a
 *      SENTINEL string, not empty. Callers must check the sentinel before
 *      treating empty output as "clean". This keeps the guard warn-only (never
 *      throws), but the status of the failing worktree is reported explicitly
 *      instead of being silently suppressed.
 */
export function gitStatusPorcelain(worktreePath, exec = execFileSync) {
  try {
    return exec('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return STATUS_CHECK_FAILED_SENTINEL;
  }
}

/**
 * Parse `git worktree list --porcelain` into absolute worktree paths.
 *
 * P2 fix (cloud R2): a worktree directory name can legitimately end in whitespace
 * (e.g. `git worktree add 'wt/dir '`). The previous `.trim()` corrupted such paths,
 * so the later `git -C <path>` would fail silently inside gitStatusPorcelain's
 * try/catch, producing a false-clean ledger entry. Strip only a trailing CR so
 * CRLF porcelain is tolerated; never touch the path's own trailing spaces.
 */
export function parseWorktreePaths(porcelain) {
  const paths = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).replace(/\r$/, '');
      if (p) paths.push(p);
    }
  }
  return paths;
}

/**
 * Collect dirty worktrees. `statusOf(path)` returns porcelain status string,
 * or `STATUS_CHECK_FAILED_SENTINEL` if the status check itself failed.
 *
 * R4 fix: a sentinel return is reported as a `statusCheckFailed: true` entry —
 * NOT silently dropped. This guarantees no large-but-dirty worktree slips
 * through unflagged just because its `git status` output overflowed the exec
 * buffer or the exec itself errored.
 */
export function collectDirtyWorktrees(paths, currentToplevel, statusOf) {
  const dirty = [];
  for (const wt of paths) {
    const raw = statusOf(wt) ?? '';
    if (raw === STATUS_CHECK_FAILED_SENTINEL) {
      dirty.push({
        path: wt,
        isCurrent: wt === currentToplevel,
        statusCheckFailed: true,
      });
      continue;
    }
    const status = raw.trim();
    if (status) {
      dirty.push({
        path: wt,
        isCurrent: wt === currentToplevel,
        fileCount: status.split('\n').filter(Boolean).length,
      });
    }
  }
  return dirty;
}

/** Format the report. Returns { dirty: boolean, lines: string[] }. */
export function formatLedger(dirty) {
  if (dirty.length === 0) {
    return { dirty: false, lines: ['[dirty-ledger] OK — no dirty worktrees'] };
  }
  const lines = [
    '[dirty-ledger] WARN — dirty worktrees found; each uncommitted diff must have a PR/task/comment id (LL-082):',
  ];
  for (const d of dirty) {
    const tag = d.isCurrent ? ' (current)' : '';
    if (d.statusCheckFailed) {
      // R4: explicit entry instead of silent-clean when `git status` itself fails
      // (buffer overflow, missing git, fs error). Investigate manually.
      lines.push(
        `[dirty-ledger]   ${d.path}${tag} — status check FAILED (likely too many files past 50MB buffer, missing git, or fs error; investigate manually)`,
      );
    } else {
      lines.push(`[dirty-ledger]   ${d.path}${tag} — ${d.fileCount} file(s) dirty`);
    }
  }
  lines.push(
    '[dirty-ledger] If any is an orphaned half-fix (H4 pattern), before merge: commit to its PR / stash with id / discard with reason.',
  );
  return { dirty: true, lines };
}

function main() {
  const currentToplevel = run('git rev-parse --show-toplevel').trim();
  const paths = parseWorktreePaths(run('git worktree list --porcelain'));
  const statusOf = (wt) => gitStatusPorcelain(wt);
  const dirty = collectDirtyWorktrees(paths, currentToplevel, statusOf);
  const { lines } = formatLedger(dirty);
  for (const line of lines) console.log(line);
  // Warn-only: dirty worktree may be legit WIP. Never blocks merge.
}

/**
 * P2 fix (cloud R3): the previous `import.meta.url === ${'`'}file://${'${'}process.argv[1]}${'`'}`
 * comparison silently failed when the repo path contained URL-escapable characters
 * (e.g. `/tmp/cat cafe`). `import.meta.url` URL-encodes them (`/tmp/cat%20cafe`),
 * but the template literal concatenated `process.argv[1]` raw, so the strings never
 * matched in that environment — `pre-merge-check.sh` still printed the ledger
 * heading, but `main()` never ran, silently disabling the guard. Decode both sides
 * via `fileURLToPath` before comparing so escape-equivalent paths line up.
 */
export function isMainEntrypoint(metaUrl, argv1) {
  if (!metaUrl || !argv1) return false;
  try {
    return fileURLToPath(metaUrl) === argv1;
  } catch {
    return false;
  }
}

// Run main only as CLI entrypoint, not when imported by tests.
if (isMainEntrypoint(import.meta.url, process.argv[1])) {
  main();
}
