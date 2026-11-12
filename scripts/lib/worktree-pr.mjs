/** Exact PR truth through the repository's canonical gh transport. No branch-name inference. */
import { execFileSync } from 'node:child_process';
import { validateOrigin } from './worktree-origin.mjs';
import { git } from './worktree-reaper-probes.mjs';
import { retentionStatus } from './worktree-retention.mjs';

const PR_SOURCE = /^pr:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
export function parsePrSource(sourceRef) {
  const match = PR_SOURCE.exec(sourceRef ?? '');
  if (!match) throw new Error('expected pr:owner/repository#number');
  return { repository: match[1], number: match[2] };
}

export function prBaseTrackingRef(repo, truth) {
  if (typeof truth.baseRef !== 'string' || !git(repo, ['check-ref-format', `refs/heads/${truth.baseRef}`]).ok)
    throw new Error('PR base ref unavailable or invalid');
  return `refs/remotes/origin/${truth.baseRef}`;
}

/** PR membership is content evidence. Only worktree-local intent establishes responsibility. */
export function worktreePrBinding(lifecycle, head) {
  if (lifecycle?.prSource !== undefined) {
    return PR_SOURCE.test(lifecycle.prSource)
      ? { sourceRef: lifecycle.prSource, evidence: 'pr-binding' }
      : { reason: 'invalid PR binding provenance' };
  }
  try {
    validateOrigin(lifecycle?.origin);
  } catch {
    return { reason: 'invalid origin provenance' };
  }
  const originSource = lifecycle?.origin?.sourceRef;
  if (originSource?.startsWith('pr:')) {
    return PR_SOURCE.test(originSource)
      ? { sourceRef: originSource, evidence: 'origin-source' }
      : { reason: 'invalid origin PR provenance' };
  }
  const retained = lifecycle?.retention;
  if (typeof retained?.sourceRef === 'string' && retained.sourceRef.startsWith('pr:')) {
    if (!PR_SOURCE.test(retained.sourceRef)) return { reason: 'invalid retained PR provenance' };
    if (retentionStatus(lifecycle) === 'retention-invalid' || retained.head !== head)
      return { reason: 'stale or invalid retained PR provenance' };
    return { sourceRef: retained.sourceRef, evidence: 'retained-source' };
  }
  return { reason: 'exact commit without worktree PR provenance' };
}

export function readPrTruth(
  sourceRef,
  run = (args) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  const { repository, number } = parsePrSource(sourceRef);
  const raw = JSON.parse(run(['api', `repos/${repository}/pulls/${number}`]));
  if (raw.base?.repo?.full_name !== repository) throw new Error('PR repository identity changed');
  const pr = {
    state: raw.merged ? 'MERGED' : raw.state === 'open' ? 'OPEN' : raw.state === 'closed' ? 'CLOSED' : null,
    headRefOid: raw.head?.sha,
    mergeCommit: { oid: raw.merge_commit_sha },
    url: raw.html_url,
  };
  const commits = run(['api', '--paginate', `repos/${repository}/pulls/${number}/commits`, '--jq', '.[].sha'])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (
    !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
    typeof raw.base.ref !== 'string' ||
    !raw.base.ref ||
    !commits.length ||
    commits.length !== raw.commits ||
    ![pr.headRefOid, ...commits].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
    !commits.includes(pr.headRefOid) ||
    (pr.state === 'MERGED' && !/^[0-9a-f]{40}$/.test(pr.mergeCommit?.oid ?? ''))
  )
    throw new Error('incomplete PR truth');
  return {
    sourceRef,
    state: pr.state,
    head: pr.headRefOid,
    mergedAt: pr.mergeCommit?.oid,
    baseRef: raw.base.ref,
    url: pr.url,
    commits,
  };
}
