/** Bounded post-merge reconciliation. Exact PR commits, never directory/branch guesses. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateOrigin } from './worktree-origin.mjs';
import { readPrTruth } from './worktree-pr.mjs';

const prRef = (value) => /^pr:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value ?? '');
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
  const candidates = rows
    .filter((row) => {
      try {
        if (
          row.notice ||
          !row.lifecycle?.origin ||
          !row.owner ||
          row.locked ||
          row.prunable ||
          row.retentionStatus === 'retained-until'
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
        if (pr.state !== 'MERGED' || !pr.commits.includes(row.head)) continue;
        const origin = row.lifecycle.origin;
        const key = createHash('sha256')
          .update(JSON.stringify([repo, row.path, row.head, row.owner, sourceRef, pr.mergedAt]))
          .digest('hex');
        notices.push({
          kind: 'merged-unfinished',
          key: `worktree:${key}`,
          threadId: origin.threadId,
          userId: origin.userId,
          owner: row.owner,
          path: row.path,
          head: row.head,
          sourceRef,
        });
      }
    } catch (error) {
      unknown.push({ path: row.path, reason: error.message });
    }
  }
  return { notices, unknown };
}
