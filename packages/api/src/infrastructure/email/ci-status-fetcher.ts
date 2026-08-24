/**
 * #320: Standalone CI status fetcher (pure gh CLI calls — no store dependency).
 * Single source of truth for CI bucket/state interpretation, consumed by CiCdCheckTaskSpec.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildGhCliEnv, withHiddenGhCliWindow } from '../github/gh-cli-env.js';
import type { CiBucket, CiCheckDetail, CiPollResult } from './ci-cd-contract.js';
import { enrichGitHubExecutionFailures } from './ci-execution-failure.js';

export {
  classifyGitHubExecutionFailure,
  type GitHubExecutionFailureEvidence,
} from './ci-execution-failure.js';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 15_000;

export type GhExecFileAsync = (file: string, args: readonly string[], options: unknown) => Promise<{ stdout: string }>;

export interface FetchPrCiStatusOptions {
  readonly ghToken?: string;
  /** Scheduler cancellation for every gh process in this poll generation. */
  readonly signal?: AbortSignal;
  /** Test seam at the real gh JSON boundary; production always uses node:child_process. */
  readonly execFileAsync?: GhExecFileAsync;
}

type MinimalLog = {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export async function executeGh(args: readonly string[], options: FetchPrCiStatusOptions): Promise<{ stdout: string }> {
  options.signal?.throwIfAborted();
  const execute = options.execFileAsync ?? (execFileAsync as unknown as GhExecFileAsync);
  return execute(
    'gh',
    args,
    withHiddenGhCliWindow({
      timeout: GH_TIMEOUT_MS,
      env: buildGhCliEnv({ token: options.ghToken }),
      signal: options.signal,
    }),
  );
}

export async function fetchPrCiStatus(
  repoFullName: string,
  prNumber: number,
  log: MinimalLog,
  options: FetchPrCiStatusOptions = {},
): Promise<CiPollResult | null> {
  let prViewJson: string;
  try {
    const { stdout } = await executeGh(
      [
        'pr',
        'view',
        String(prNumber),
        '-R',
        repoFullName,
        '--json',
        'headRefOid,state,mergedAt,mergedBy,statusCheckRollup',
      ],
      options,
    );
    prViewJson = stdout;
  } catch (err) {
    options.signal?.throwIfAborted();
    log.warn(`[ci-status] gh pr view failed for ${repoFullName}#${prNumber}: ${String(err)}`);
    return null;
  }

  let prView: {
    headRefOid: string;
    state: string;
    mergedAt: string | null;
    mergedBy: { login: string } | null;
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
    return {
      repoFullName,
      prNumber,
      headSha: prView.headRefOid,
      prState,
      aggregateBucket: 'pending',
      checks: [],
      mergedByLogin: prView.mergedBy?.login,
    };
  }

  const rollup = prView.statusCheckRollup ?? [];
  const aggregateBucket = computeAggregateBucket(rollup);

  let checks: CiCheckDetail[] = [];
  if (aggregateBucket !== 'pending') {
    checks = await fetchCheckDetails(repoFullName, prNumber, prView.headRefOid, log, options);
  }

  return {
    repoFullName,
    prNumber,
    headSha: prView.headRefOid,
    prState,
    aggregateBucket,
    checkRollup: rollup.length === 0 ? 'empty' : 'present',
    checks,
  };
}

async function fetchCheckDetails(
  repoFullName: string,
  prNumber: number,
  headSha: string,
  log: MinimalLog,
  options: FetchPrCiStatusOptions,
): Promise<CiCheckDetail[]> {
  let checks = await fetchRequiredFailingChecks(repoFullName, prNumber, options);
  if (!checks) {
    try {
      checks = await fetchGhCheckDetails(repoFullName, prNumber, false, options);
    } catch (err) {
      options.signal?.throwIfAborted();
      log.warn(`[ci-status] gh pr checks failed for ${repoFullName}#${prNumber}: ${String(err)}`);
      return [];
    }
  }

  return enrichGitHubExecutionFailures({
    repoFullName,
    headSha,
    checks,
    ghApiJson: (path) => ghApiJson(path, options),
    warn: (message) => log.warn(message),
  });
}

async function fetchGhCheckDetails(
  repoFullName: string,
  prNumber: number,
  requiredOnly: boolean,
  options: FetchPrCiStatusOptions,
): Promise<CiCheckDetail[]> {
  const args = [
    'pr',
    'checks',
    String(prNumber),
    '-R',
    repoFullName,
    '--json',
    'name,bucket,link,workflow,description',
  ];
  if (requiredOnly) args.push('--required');
  const { stdout } = await executeGh(args, options);
  const parsed = JSON.parse(stdout) as Array<{
    name: string;
    bucket: string;
    link?: string;
    workflow?: string;
    description?: string;
  }>;
  return parsed.map((check) => ({
    name: check.name,
    bucket: normalizeBucket(check.bucket),
    link: check.link,
    workflow: check.workflow,
    description: check.description,
  }));
}

/** Preserve the historical `gh pr checks --required` failure projection. */
export async function fetchRequiredFailingChecks(
  repoFullName: string,
  prNumber: number,
  options: FetchPrCiStatusOptions,
): Promise<CiCheckDetail[] | null> {
  try {
    const checks = await fetchGhCheckDetails(repoFullName, prNumber, true, options);
    return checks.some((check) => check.bucket === 'fail') ? checks : null;
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

export async function ghApiJson<T>(path: string, options: FetchPrCiStatusOptions): Promise<T> {
  const { stdout } = await executeGh(['api', path], options);
  return JSON.parse(stdout) as T;
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
  // A single empty rollup is ambiguous: GitHub may not have created the check
  // runs yet for a fresh HEAD. CiCdRouter owns the persisted same-HEAD stability
  // guard that eventually promotes a genuinely empty rollup to pass.
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
