/** Complete, read-only linked-checkout inventory. Capacity is a different projection. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { validateOrigin } from './worktree-origin.mjs';
import { quarantineRoot } from './worktree-quarantine.mjs';
import { isProtected, parseWorktreePorcelain } from './worktree-reaper-core.mjs';
import { git, lifecycleConfig, safeRealpath } from './worktree-reaper-probes.mjs';
import { retentionStatus } from './worktree-retention.mjs';

function noticeFor(row, repo) {
  const status = row.retentionStatus;
  if (!status || status === 'retained-until') return undefined;
  const origin = row.lifecycle?.origin;
  try {
    if (!origin) return undefined;
    validateOrigin(origin);
    if (!origin.userId || !row.owner) return undefined;
  } catch {
    return undefined;
  }
  // One reminder per retained intent and condition, rather than per newer checkout HEAD.
  // Expiry is a distinct event even if a version-change reminder was already delivered.
  const revision = JSON.stringify([
    2,
    repo,
    row.path,
    status,
    row.owner,
    origin.threadId,
    origin.userId,
    row.lifecycle.retention,
  ]);
  return {
    kind: status,
    key: `worktree:${createHash('sha256').update(revision).digest('hex')}`,
    threadId: origin.threadId,
    userId: origin.userId,
    owner: row.owner,
    path: row.path,
    head: row.head,
    sourceRef:
      typeof row.lifecycle.retention?.sourceRef === 'string' ? row.lifecycle.retention.sourceRef : origin.sourceRef,
    until: typeof row.lifecycle.retention?.until === 'string' ? row.lifecycle.retention.until : undefined,
  };
}

export function worktreeInventory(repo, { now = Date.now() } = {}) {
  const result = git(repo, ['worktree', 'list', '--porcelain']);
  if (!result.ok) throw new Error('worktree inventory unavailable');
  const records = parseWorktreePorcelain(result.out);
  if (!records.length) throw new Error('empty worktree registration');
  const primary = safeRealpath(records[0].path);
  const quarantine = quarantineRoot(dirname(primary));
  return records
    .filter((r) => {
      const path = safeRealpath(r.path);
      return (
        path !== primary &&
        !isProtected(basename(path), undefined, basename(primary)) &&
        !path.startsWith(`${quarantine}/`)
      );
    })
    .map((r) => {
      const path = safeRealpath(r.path);
      const lifecycle = existsSync(path) && !r.prunable ? lifecycleConfig(path, '--worktree') : null;
      const row = {
        ...r,
        path,
        lifecycle,
        owner: lifecycle?.owner ?? null,
        declaration: lifecycle === null ? 'unknown' : lifecycle.policy ? 'declared' : 'legacy',
        retentionStatus: retentionStatus(lifecycle, now),
      };
      if (row.retentionStatus === 'retained-until' && lifecycle.retention.head !== row.head)
        row.retentionStatus = 'retention-head-changed';
      const notice = noticeFor(row, primary);
      return { ...row, ...(notice ? { notice } : {}) };
    });
}

/** A PR's full commit list catches intermediate review heads, including squash merges. */
export function associatedWorktrees({ repo, sourceRef, commits = [], now }) {
  const exactCommits = new Set(commits);
  return worktreeInventory(repo, { now }).filter(
    (row) =>
      row.lifecycle?.origin?.sourceRef === sourceRef ||
      row.lifecycle?.prSource === sourceRef ||
      row.lifecycle?.retention?.sourceRef === sourceRef ||
      exactCommits.has(row.head),
  );
}
