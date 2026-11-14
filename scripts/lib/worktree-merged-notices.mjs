/** Bounded post-merge reconciliation. Exact PR commits, never directory/branch guesses. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completedDirectRelease, directReleaseReceipt } from './worktree-direct-release.mjs';
import { validateOrigin } from './worktree-origin.mjs';
import { readPrTruth, worktreePrBinding } from './worktree-pr.mjs';
import { git } from './worktree-reaper-probes.mjs';
import { automaticReleaseTransactions, releaseRoot } from './worktree-release-transactions.mjs';

const prRef = (value) => /^pr:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value ?? '');
export function mergedNoticeKey(repo, path, head, owner, sourceRef, mergedAt, createdAt) {
  return `worktree:${createHash('sha256')
    .update(JSON.stringify([repo, path, head, owner, sourceRef, mergedAt, ...(createdAt ? [createdAt] : [])]))
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

function unambiguousLegacyRelease(root, path, txn) {
  return !readFileSync(join(root, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .some((line) => {
      try {
        const r = JSON.parse(line);
        return r.from === path && r.action === 'release' && r.state === 'pending' && r.txn !== txn;
      } catch {
        return false;
      }
    });
}

/** Resolve one old merged reminder against the existing release owner, never against path absence alone. */
export function completedMergedNoticeRelease(repo, subject, { readPr = readPrTruth } = {}) {
  const root = releaseRoot(repo);
  const r = completedDirectRelease({ repo, root, path: subject.path });
  if (
    !r ||
    !prRef(subject.sourceRef) ||
    r.owner !== subject.owner ||
    (r.mergedPr ?? r.sourceRef) !== subject.sourceRef ||
    r.origin?.threadId !== subject.threadId ||
    r.origin?.userId !== subject.userId ||
    !/^worktree:[0-9a-f]{64}$/.test(subject.key ?? '') ||
    (subject.head && subject.head !== r.head)
  )
    return null;
  const receipt = directReleaseReceipt({
    repo,
    root,
    path: subject.path,
    owner: subject.owner,
    sourceRef: r.sourceRef,
  });
  if (!receipt) return null;
  const config = join(receipt.archivePath, 'git-metadata/config.worktree');
  const read = (key) => {
    const result = git(repo, ['config', '--file', config, '--get', `catcafe.lifecycle.${key}`]);
    if (!result.ok) throw new Error('archived worktree lifecycle unavailable');
    return result.out.trim();
  };
  const birth = read('createdAt');
  const createdAt = Date.parse(birth);
  if (!Number.isFinite(subject.observedAt) || !Number.isFinite(createdAt) || createdAt > subject.observedAt)
    return null;
  const origin = JSON.parse(read('origin'));
  if (
    read('owner') !== subject.owner ||
    ['threadId', 'userId', 'sourceRef', 'role'].some((key) => origin[key] !== r.origin[key])
  )
    return null;
  // Old display metadata deliberately omitted HEAD. Its existing content-addressed key
  // still binds the exact head/source/merge; manual historical releases may need PR truth.
  let mergedAt = r.mergedAt;
  if (!mergedAt) {
    const pr = readPr(subject.sourceRef);
    if (pr.sourceRef !== subject.sourceRef || pr.state !== 'MERGED' || !pr.commits.includes(r.head)) return null;
    mergedAt = pr.mergedAt;
  }
  const exact = mergedNoticeKey(repo, r.from, r.head, r.owner, subject.sourceRef, mergedAt, birth);
  const legacy = mergedNoticeKey(repo, r.from, r.head, r.owner, subject.sourceRef, mergedAt);
  if (subject.key !== exact && (subject.key !== legacy || !unambiguousLegacyRelease(root, r.from, r.txn))) return null;
  return receipt;
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
      const binding = worktreePrBinding(row.lifecycle, row.head);
      const sources = binding.sourceRef ? [binding.sourceRef] : findSources(row.head);
      for (const sourceRef of new Set(sources)) {
        if (!cache.has(sourceRef)) cache.set(sourceRef, readPr(sourceRef));
        const pr = cache.get(sourceRef);
        if (pr.sourceRef !== sourceRef || pr.state !== 'MERGED' || !pr.commits.includes(row.head)) continue;
        if (binding.sourceRef !== sourceRef) {
          unknown.push({ path: row.path, sourceRef, reason: binding.reason });
          continue;
        }
        const origin = row.lifecycle.origin;
        notices.push({
          kind: 'merged-unfinished',
          key: mergedNoticeKey(repo, row.path, row.head, row.owner, sourceRef, pr.mergedAt, row.lifecycle.createdAt),
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
