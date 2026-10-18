/**
 * #320: Standalone CI status fetcher (pure gh CLI calls — no store dependency).
 * Single source of truth for CI bucket/state interpretation, consumed by CiCdCheckTaskSpec.
 */
import { executeGitHubRequest, GitHubRateLimitError } from '../github/request-budget.js';
import type { CiBucket, CiCheckDetail, CiPollResult } from './ci-cd-contract.js';
import { readGitHubExecutionFailures } from './ci-execution-failure.js';

export {
  classifyGitHubExecutionFailure,
  type GitHubExecutionFailureEvidence,
} from './ci-execution-failure.js';

export type GhExecFileAsync = (file: string, args: readonly string[], options: unknown) => Promise<{ stdout: string }>;

export interface FetchPrCiStatusOptions {
  readonly ghToken?: string;
  readonly timeoutMs?: number;
  /** Keep tick admission bounded; enrich failures during per-PR execution. */
  readonly deferFailureDetails?: boolean;
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
  return executeGitHubRequest([...args], options);
}

export async function fetchPrCiStatus(
  repoFullName: string,
  prNumber: number,
  log: MinimalLog,
  options: FetchPrCiStatusOptions = {},
): Promise<CiPollResult | null> {
  const observedAt = Date.now();
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
    if (err instanceof GitHubRateLimitError) throw err;
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
  if (
    !prView ||
    typeof prView.headRefOid !== 'string' ||
    !prView.headRefOid ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(prView.state)
  ) {
    log.warn(`[ci-status] Missing PR/HEAD facts for ${repoFullName}#${prNumber}`);
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
      observedAt,
      mergedByLogin: prView.mergedBy?.login,
    };
  }

  const rollup = prView.statusCheckRollup ?? [];
  const aggregateBucket = computeAggregateBucket(rollup);

  let checks: CiCheckDetail[] = [];
  let detailsComplete = true;
  if (aggregateBucket !== 'pending' && !options.deferFailureDetails) {
    ({ checks, complete: detailsComplete } = await fetchCheckDetails(
      repoFullName,
      prNumber,
      prView.headRefOid,
      log,
      options,
    ));
  }

  return {
    repoFullName,
    prNumber,
    headSha: prView.headRefOid,
    prState,
    aggregateBucket,
    checkRollup: rollup.length === 0 ? 'empty' : 'present',
    checks,
    observedAt,
    ...(aggregateBucket === 'fail' && options.deferFailureDetails ? { failureDetailsPending: true } : {}),
    ...(detailsComplete ? {} : { failureDetailsIncomplete: true }),
  };
}

export async function enrichPrCiFailure(
  poll: CiPollResult,
  log: MinimalLog,
  options: FetchPrCiStatusOptions,
): Promise<CiPollResult> {
  // Failure details were deferred: GitHub may have received another push or a
  // same-HEAD rerun meanwhile. Re-read CI truth before consuming those details.
  const complete = await fetchPrCiStatus(poll.repoFullName, poll.prNumber, log, {
    ...options,
    deferFailureDetails: false,
  });
  if (!complete) throw new Error(`CI rollup unavailable for ${poll.repoFullName}#${poll.prNumber}; retry next poll`);
  if (!poll.fullRollupPending && complete.prState === 'open' && complete.headSha !== poll.headSha)
    throw new Error(`Stale CI snapshot for ${poll.repoFullName}#${poll.prNumber}; retry current HEAD`);
  return complete;
}

async function fetchCheckDetails(
  repoFullName: string,
  prNumber: number,
  headSha: string,
  log: MinimalLog,
  options: FetchPrCiStatusOptions,
): Promise<{ checks: CiCheckDetail[]; complete: boolean }> {
  const required = await readRequiredFailingChecks(repoFullName, prNumber, options);
  let checks = required.checks;
  if (!checks) {
    try {
      checks = await fetchGhCheckDetails(repoFullName, prNumber, false, options);
    } catch (err) {
      options.signal?.throwIfAborted();
      if (err instanceof GitHubRateLimitError) throw err;
      log.warn(`[ci-status] gh pr checks failed for ${repoFullName}#${prNumber}: ${String(err)}`);
      return { checks: [], complete: false };
    }
  }

  const enriched = await readGitHubExecutionFailures({
    signal: options.signal,
    repoFullName,
    headSha,
    checks,
    ghApiJson: (path) => ghApiJson(path, options),
    warn: (message) => log.warn(message),
  });
  return { checks: enriched.checks, complete: required.complete && enriched.complete };
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
  return (await readRequiredFailingChecks(repoFullName, prNumber, options)).checks;
}

/** `checks: null` means "use every check": none required failed, or (`complete: false`) the read failed. */
async function readRequiredFailingChecks(
  repoFullName: string,
  prNumber: number,
  options: FetchPrCiStatusOptions,
): Promise<{ checks: CiCheckDetail[] | null; complete: boolean }> {
  try {
    const checks = await fetchGhCheckDetails(repoFullName, prNumber, true, options);
    return { checks: checks.some((check) => check.bucket === 'fail') ? checks : null, complete: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof GitHubRateLimitError) throw error;
    return { checks: null, complete: false };
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
  // An empty rollup is ambiguous: GitHub may not have created the check runs yet
  // for a fresh HEAD, or the repository may define no checks. Neither is positive
  // CI evidence, so the router keeps this pending across later polls too.
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

/** The batch rollup a detail read describes: HEAD and every check's state and link (a rerun gets new links). */
export function failureDetailRollup(poll: CiPollResult): string | undefined {
  if (!poll.failureDetailsPending || poll.fullRollupPending) return undefined;
  const checks = poll.checks
    .map((check) => JSON.stringify([check.name, check.bucket, check.link, check.workflow, check.description]))
    .sort();
  return JSON.stringify([poll.headSha, poll.prState, poll.aggregateBucket, poll.checkRollup, checks]);
}

/** A detail read describes its batch rollup only if every read succeeded and it saw the same PR state. */
export function describesRollup(poll: CiPollResult, details: CiPollResult): boolean {
  return (
    details.failureDetailsIncomplete !== true &&
    details.headSha === poll.headSha &&
    details.prState === poll.prState &&
    details.aggregateBucket === poll.aggregateBucket
  );
}
