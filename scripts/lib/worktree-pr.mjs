/** Exact PR truth through the repository's canonical gh transport. No branch-name inference. */
import { execFileSync } from 'node:child_process';
export function parsePrSource(sourceRef) {
  const match = /^pr:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(sourceRef ?? '');
  if (!match) throw new Error('expected pr:owner/repository#number');
  return { repository: match[1], number: match[2] };
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
    !commits.length ||
    commits.length !== raw.commits ||
    ![pr.headRefOid, ...commits].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
    (pr.state === 'MERGED' && !/^[0-9a-f]{40}$/.test(pr.mergeCommit?.oid ?? ''))
  )
    throw new Error('incomplete PR truth');
  return { sourceRef, state: pr.state, head: pr.headRefOid, mergedAt: pr.mergeCommit?.oid, url: pr.url, commits };
}
