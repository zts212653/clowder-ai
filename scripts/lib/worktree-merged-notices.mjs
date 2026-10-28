/** Bounded post-merge reconciliation. Exact PR commits, never directory/branch guesses. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateOrigin } from './worktree-origin.mjs';
import { readPrTruth } from './worktree-pr.mjs';
import { automaticReleaseTransactions } from './worktree-release-transactions.mjs';

const prRef = (value) => /^pr:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value ?? '');
export function mergedNoticeKey(repo, path, head, owner, sourceRef, mergedAt) {
  return `worktree:${createHash('sha256')
    .update(JSON.stringify([repo, path, head, owner, sourceRef, mergedAt]))
    .digest('hex')}`;
}
export function releasedNoticeKey(repo, release) {
  return `worktree:${createHash('sha256')
    .update(
      JSON.stringify([
        repo,
        release.from,
        release.head,
        release.owner,
        release.mergedPr,
        release.mergedAt,
        release.archivePath,
      ]),
    )
    .digest('hex')}`;
}

/** Replay normal completions and explicit interrupted/aborted outcomes through the same History delivery. */
export function releasedWorktreeNotices(repo, rows, { now = Date.now() } = {}) {
  const notices = automaticReleaseTransactions(repo).flatMap((r) => {
    try {
      validateOrigin(r.origin);
      if (!r.origin?.userId || !prRef(r.mergedPr) || r.state === 'pending') return [];
      const removed = ['done', 'reconciled-removed'].includes(r.state);
      if (
        removed &&
        (existsSync(r.from) ||
          rows.some((row) => row.path === r.from) ||
          !existsSync(join(r.archivePath, 'manifest.json')))
      )
        return [];
      if (!removed && !['aborted', 'interrupted'].includes(r.state)) return [];
      return [
        {
          kind: removed
            ? r.state === 'done'
              ? 'merged-removed'
              : 'merged-removal-interrupted'
            : 'merged-retirement-blocked',
          key: releasedNoticeKey(repo, r),
          threadId: r.origin.threadId,
          userId: r.origin.userId,
          owner: r.owner,
          path: r.from,
          head: r.head,
          sourceRef: r.mergedPr,
          ...(r.state !== 'aborted' ? { archivePath: r.archivePath } : {}),
          ...(removed ? { restore: r.restore } : {}),
          ...(!removed ? { reason: r.reason } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
  const batches = Math.ceil(notices.length / 4);
  const offset = batches ? (Math.floor(now / 300000) % batches) * 4 : 0;
  return notices.slice(offset, offset + 4);
}
function sourceForHead(repo, head, run) {
  const repository = run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repo).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository identity unknown');
  const pulls = JSON.parse(run(['api', `repos/${repository}/commits/${head}/pulls`], repo));
  return pulls
    .filter((p) => p.merged_at && p.base?.repo?.full_name === repository)
    .map((p) => `pr:${repository}#${p.number}`);
}
export function mergedWorktreeNotices(repo, rows, { now = Date.now(), readPr, findSources, run } = {}) {
  const started = Date.now();
  run ??= (args, cwd = repo) => {
    if (Date.now() - started > 12000) throw new Error('merged inventory query budget exhausted');
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  readPr ??= (ref) => readPrTruth(ref, run);
  findSources ??= (head) => sourceForHead(repo, head, run);
  const paused = automaticReleaseTransactions(repo).filter((r) => !['done', 'reconciled-removed'].includes(r.state));
  const candidates = rows
    .filter((row) => {
      try {
        if (
          !row.lifecycle?.origin ||
          !row.owner ||
          paused.some((r) => r.from === row.path && r.head === row.head) ||
          row.locked ||
          row.prunable ||
          (row.retentionStatus && row.retentionStatus !== 'retention-expired')
        )
          return false;
        validateOrigin(row.lifecycle.origin);
        return Boolean(row.lifecycle.origin.userId);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  // At most four checkout subjects per five-minute sweep. Rotate deterministically so a busy
  // repository cannot starve old subjects; no persistent second owner/cursor registry.
  const batches = Math.ceil(candidates.length / 4);
  const offset = batches ? (Math.floor(now / 300000) % batches) * 4 : 0;
  const selected = candidates.slice(offset, offset + 4);
  const cache = new Map();
  const notices = [];
  const unknown = [];
  for (const row of selected) {
    try {
      const bound = [row.lifecycle.prSource, row.lifecycle.origin.sourceRef, row.lifecycle.retention?.sourceRef].find(
        prRef,
      );
      const sources = bound ? [bound] : findSources(row.head);
      for (const sourceRef of sources) {
        if (!cache.has(sourceRef)) cache.set(sourceRef, readPr(sourceRef));
        const pr = cache.get(sourceRef);
        if (pr.sourceRef !== sourceRef || pr.state !== 'MERGED' || !pr.commits.includes(row.head)) continue;
        const origin = row.lifecycle.origin;
        notices.push({
          kind: 'merged-unfinished',
          key: mergedNoticeKey(repo, row.path, row.head, row.owner, sourceRef, pr.mergedAt),
          threadId: origin.threadId,
          userId: origin.userId,
          owner: row.owner,
          path: row.path,
          head: row.head,
          sourceRef,
        });
        break;
      }
    } catch (error) {
      unknown.push({ path: row.path, reason: error.message });
    }
  }
  return { notices, unknown };
}
