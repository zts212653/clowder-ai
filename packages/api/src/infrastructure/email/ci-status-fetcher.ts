/**
 * #320: Standalone CI status fetcher (pure gh CLI calls — no store dependency).
 * Single source of truth for CI bucket/state interpretation, consumed by CiCdCheckTaskSpec.
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

export function normalizePrState(state: string, mergedAt: string | null): 'open' | 'merged' | 'closed' {
  if (mergedAt || state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

export function normalizeBucket(bucket: string): CiBucket {
  const lower = bucket.toLowerCase();
  if (lower === 'pass' || lower === 'success') return 'pass';
  if (lower === 'fail' || lower === 'failure' || lower === 'error') return 'fail';
  return 'pending';
}

export function computeAggregateBucket(
  rollup: Array<{ status: string; conclusion: string; __typename: string }>,
): CiBucket {
  if (rollup.length === 0) return 'pending';
  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false; // at least one REAL positive result (success/skipped/neutral)
  for (const item of rollup) {
    if (item.__typename === 'StatusContext') {
      const state = item.status?.toLowerCase();
      if (state === 'failure' || state === 'error') hasFailure = true;
      else if (state === 'success') hasSuccess = true;
      else hasPending = true; // pending / expected
    } else {
      const conclusion = item.conclusion?.toLowerCase();
      // 'cancelled' is a superseded/aborted NON-result: GitHub auto-cancels in-progress runs when a
      // newer commit is pushed. It is neither a failure (so it can't fire a false CI-fail) nor a
      // success — GitHub's success states are success/skipped/neutral, NOT cancelled. So a PR needs
      // at least one REAL positive result to be 'pass': [cancelled + passing-re-run] → pass, but
      // [cancelled only] → pending (never a false green light for a waiting merge-gate).
      if (conclusion === 'failure' || conclusion === 'timed_out') hasFailure = true;
      else if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') hasSuccess = true;
      else if (conclusion !== 'cancelled') hasPending = true; // in-progress / no conclusion / unknown
    }
  }
  if (hasFailure) return 'fail';
  if (hasPending) return 'pending';
  return hasSuccess ? 'pass' : 'pending'; // only cancelled / no positive result → not a green light
}
