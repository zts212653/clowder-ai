/**
 * #320: Standalone CI status fetcher extracted from CiCdCheckPoller.
 * Pure gh CLI calls — no store dependency.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CiBucket, CiCheckDetail, CiPollResult } from './CiCdRouter.js';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 15_000;

type MinimalLog = {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export async function fetchPrCiStatus(
  repoFullName: string,
  prNumber: number,
  log: MinimalLog,
): Promise<CiPollResult | null> {
  let prViewJson: string;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', String(prNumber), '-R', repoFullName, '--json', 'headRefOid,state,mergedAt,statusCheckRollup'],
      { timeout: GH_TIMEOUT_MS },
    );
    prViewJson = stdout;
  } catch (err) {
    log.warn(`[ci-status] gh pr view failed for ${repoFullName}#${prNumber}: ${String(err)}`);
    return null;
  }

  let prView: {
    headRefOid: string;
    state: string;
    mergedAt: string | null;
    statusCheckRollup: Array<{ name: string; status: string; conclusion: string; __typename: string }>;
  };
  try {
    prView = JSON.parse(prViewJson);
  } catch {
    log.warn(`[ci-status] Failed to parse gh pr view output for ${repoFullName}#${prNumber}`);
    return null;
  }

  const prState = normalizePrState(prView.state, prView.mergedAt);
  if (prState === 'merged' || prState === 'closed') {
    return { repoFullName, prNumber, headSha: prView.headRefOid, prState, aggregateBucket: 'pending', checks: [] };
  }

  const rollup = prView.statusCheckRollup ?? [];
  const aggregateBucket = computeAggregateBucket(rollup);

  let checks: CiCheckDetail[] = [];
  if (aggregateBucket !== 'pending') {
    checks = await fetchCheckDetails(repoFullName, prNumber, log);
  }

  return { repoFullName, prNumber, headSha: prView.headRefOid, prState, aggregateBucket, checks };
}

async function fetchCheckDetails(repoFullName: string, prNumber: number, log: MinimalLog): Promise<CiCheckDetail[]> {
  for (const requiredFlag of ['--required', '']) {
    try {
      const args = [
        'pr',
        'checks',
        String(prNumber),
        '-R',
        repoFullName,
        '--json',
        'name,bucket,link,workflow,description',
      ];
      if (requiredFlag) args.push(requiredFlag);

      const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS });
      const parsed: Array<{ name: string; bucket: string; link?: string; workflow?: string; description?: string }> =
        JSON.parse(stdout);

      if (parsed.length > 0) {
        const mapped = parsed.map((c) => ({
          name: c.name,
          bucket: normalizeBucket(c.bucket),
          link: c.link,
          workflow: c.workflow,
          description: c.description,
        }));
        if (requiredFlag && !mapped.some((c) => c.bucket === 'fail')) {
          continue;
        }
        return mapped;
      }

      if (!requiredFlag) {
        return parsed.map((c) => ({
          name: c.name,
          bucket: normalizeBucket(c.bucket),
          link: c.link,
          workflow: c.workflow,
          description: c.description,
        }));
      }
    } catch (err) {
      if (requiredFlag) continue;
      log.warn(`[ci-status] gh pr checks failed for ${repoFullName}#${prNumber}: ${String(err)}`);
      return [];
    }
  }
  return [];
}

function normalizePrState(state: string, mergedAt: string | null): 'open' | 'merged' | 'closed' {
  if (mergedAt || state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

function normalizeBucket(bucket: string): CiBucket {
  const lower = bucket.toLowerCase();
  if (lower === 'pass' || lower === 'success') return 'pass';
  if (lower === 'fail' || lower === 'failure' || lower === 'error') return 'fail';
  return 'pending';
}

function computeAggregateBucket(rollup: Array<{ status: string; conclusion: string; __typename: string }>): CiBucket {
  if (rollup.length === 0) return 'pending';
  let hasFailure = false;
  let hasPending = false;
  for (const item of rollup) {
    if (item.__typename === 'StatusContext') {
      const state = item.status?.toLowerCase();
      if (state === 'failure' || state === 'error') hasFailure = true;
      else if (state !== 'success') hasPending = true;
    } else {
      const conclusion = item.conclusion?.toLowerCase();
      const status = item.status?.toLowerCase();
      if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') hasFailure = true;
      else if (status !== 'completed' || !conclusion || conclusion === '' || conclusion === 'neutral')
        hasPending = true;
      else if (conclusion !== 'success' && conclusion !== 'skipped') hasPending = true;
    }
  }
  if (hasFailure) return 'fail';
  if (hasPending) return 'pending';
  return 'pass';
}
