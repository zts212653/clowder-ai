import { executeGh, type FetchPrCiStatusOptions } from '../email/ci-status-fetcher.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface PrMergeFacts {
  readonly mergeState: string;
  readonly mergeStateStatus: string;
  readonly headSha: string;
  /** Exact base/head ancestry from GitHub's compare API; independent of merge readiness. */
  readonly isBehind: boolean;
}

/**
 * Read the two independent PR facts that GitHub exposes through different APIs.
 *
 * `mergeStateStatus` summarizes merge readiness. It cannot answer base ancestry: a DIRTY PR can
 * still be behind, while a BLOCKED or UNSTABLE PR can already be caught up. The compare endpoint's
 * `behind_by` is the authoritative source for the base-behind tracking surface.
 */
export async function fetchPrMergeFacts(
  repoFullName: string,
  prNumber: number,
  options: FetchPrCiStatusOptions = {},
): Promise<PrMergeFacts> {
  const { stdout: prViewJson } = await executeGh(
    ['pr', 'view', String(prNumber), '-R', repoFullName, '--json', 'mergeable,mergeStateStatus,baseRefOid,headRefOid'],
    options,
  );
  const prView = JSON.parse(prViewJson) as {
    readonly mergeable?: unknown;
    readonly mergeStateStatus?: unknown;
    readonly baseRefOid?: unknown;
    readonly headRefOid?: unknown;
  };
  const baseSha = typeof prView.baseRefOid === 'string' ? prView.baseRefOid : '';
  const headSha = typeof prView.headRefOid === 'string' ? prView.headRefOid : '';
  if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha)) {
    throw new Error(`GitHub PR exact base/head unavailable for ${repoFullName}#${prNumber}`);
  }

  const { stdout: behindByText } = await executeGh(
    ['api', `/repos/${repoFullName}/compare/${baseSha}...${headSha}`, '--jq', '.behind_by'],
    options,
  );
  const normalizedBehindBy = behindByText.trim();
  const behindBy = Number(normalizedBehindBy);
  if (!/^(?:0|[1-9]\d*)$/.test(normalizedBehindBy) || !Number.isSafeInteger(behindBy)) {
    throw new Error(`GitHub comparison behind_by unavailable for ${repoFullName}#${prNumber}`);
  }

  return {
    mergeState: typeof prView.mergeable === 'string' ? prView.mergeable : 'UNKNOWN',
    mergeStateStatus: typeof prView.mergeStateStatus === 'string' ? prView.mergeStateStatus : 'UNKNOWN',
    headSha,
    isBehind: behindBy > 0,
  };
}
