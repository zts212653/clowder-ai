/** F304: batched GitHub GraphQL reader for one cicd-check tick. */
import type { CiCheckDetail, CiPollResult } from './ci-cd-contract.js';
import { enrichGitHubExecutionFailures } from './ci-execution-failure.js';
import {
  computeAggregateBucket,
  executeGh,
  type FetchPrCiStatusOptions,
  fetchPrCiStatus,
  fetchRequiredFailingChecks,
  ghApiJson,
  normalizeBucket,
  normalizePrState,
} from './ci-status-fetcher.js';

export interface PrCiStatusTarget {
  readonly repoFullName: string;
  readonly prNumber: number;
}

export function ciStatusTargetKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

type MinimalLog = { warn: (...args: unknown[]) => void };

interface GraphQlCheckRun {
  readonly __typename: 'CheckRun';
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl?: string | null;
  readonly checkSuite?: {
    readonly workflowRun?: { readonly workflow?: { readonly name?: string | null } | null } | null;
  } | null;
}

interface GraphQlStatusContext {
  readonly __typename: 'StatusContext';
  readonly context: string;
  readonly state: string;
  readonly description?: string | null;
  readonly targetUrl?: string | null;
}

type GraphQlRollupContext = GraphQlCheckRun | GraphQlStatusContext;

interface GraphQlPr {
  readonly headRefOid: string;
  readonly state: string;
  readonly mergedAt: string | null;
  readonly mergedBy: { readonly login?: string | null } | null;
  readonly commits?: {
    readonly nodes?: ReadonlyArray<{
      readonly commit?: {
        readonly statusCheckRollup?: {
          readonly contexts?: {
            readonly nodes?: readonly GraphQlRollupContext[];
            readonly pageInfo?: { readonly hasNextPage?: boolean };
          } | null;
        } | null;
      } | null;
    }>;
  } | null;
}

interface BatchTargetRef extends PrCiStatusTarget {
  readonly repoAlias: string;
  readonly prAlias: string;
}

interface BatchGraphQlResponse {
  readonly data?: Record<string, Record<string, GraphQlPr | null> | null>;
  readonly errors?: unknown;
}

function parseBatchGraphQlResponse(stdout: string): BatchGraphQlResponse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed != null && typeof parsed === 'object' ? (parsed as BatchGraphQlResponse) : null;
  } catch {
    return null;
  }
}

function stdoutFromExecError(error: unknown): string | null {
  if (error == null || typeof error !== 'object' || !('stdout' in error)) return null;
  const stdout = (error as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string') return stdout;
  return stdout instanceof Uint8Array ? new TextDecoder().decode(stdout) : null;
}

function splitRepo(repoFullName: string): { owner: string; name: string } | null {
  const separator = repoFullName.indexOf('/');
  if (separator <= 0 || separator === repoFullName.length - 1 || repoFullName.indexOf('/', separator + 1) !== -1) {
    return null;
  }
  return { owner: repoFullName.slice(0, separator), name: repoFullName.slice(separator + 1) };
}

function buildBatchQuery(targets: readonly PrCiStatusTarget[]): {
  readonly query: string;
  readonly refs: readonly BatchTargetRef[];
} {
  const grouped = new Map<string, { repoAlias: string; owner: string; name: string; targets: BatchTargetRef[] }>();
  const refs: BatchTargetRef[] = [];
  for (const target of targets) {
    const repo = splitRepo(target.repoFullName);
    if (!repo || !Number.isSafeInteger(target.prNumber) || target.prNumber <= 0) continue;
    let group = grouped.get(target.repoFullName);
    if (!group) {
      group = { repoAlias: `r${grouped.size}`, ...repo, targets: [] };
      grouped.set(target.repoFullName, group);
    }
    const ref = { ...target, repoAlias: group.repoAlias, prAlias: `p${refs.length}` };
    group.targets.push(ref);
    refs.push(ref);
  }

  const repositories = [...grouped.values()].map((group) => {
    const pullRequests = group.targets
      .map(
        (target) => `${target.prAlias}: pullRequest(number: ${target.prNumber}) {
          headRefOid state mergedAt mergedBy { login }
          commits(last: 1) { nodes { commit { statusCheckRollup {
            contexts(first: 100) { nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
              ... on StatusContext { context state description targetUrl }
            } pageInfo { hasNextPage } }
          } } } }
        }`,
      )
      .join('\n');
    return `${group.repoAlias}: repository(owner: ${JSON.stringify(group.owner)}, name: ${JSON.stringify(group.name)}) {
      ${pullRequests}
    }`;
  });
  return { query: `query BatchPrCi { ${repositories.join('\n')} }`, refs };
}

function graphQlRollup(pr: GraphQlPr): readonly GraphQlRollupContext[] {
  return pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
}

function mapGraphQlCheck(context: GraphQlRollupContext): CiCheckDetail {
  if (context.__typename === 'StatusContext') {
    return {
      name: context.context,
      bucket: normalizeBucket(context.state),
      ...(context.targetUrl ? { link: context.targetUrl } : {}),
      ...(context.description ? { description: context.description } : {}),
    };
  }
  const workflow = context.checkSuite?.workflowRun?.workflow?.name;
  return {
    name: context.name,
    bucket: normalizeBucket(context.conclusion ?? context.status),
    ...(context.detailsUrl ? { link: context.detailsUrl } : {}),
    ...(workflow ? { workflow } : {}),
  };
}

async function graphQlPrToPollResult(
  ref: BatchTargetRef,
  pr: GraphQlPr,
  log: MinimalLog,
  options: FetchPrCiStatusOptions,
): Promise<CiPollResult | null> {
  options.signal?.throwIfAborted();
  const key = ciStatusTargetKey(ref.repoFullName, ref.prNumber);
  const prState = normalizePrState(pr.state, pr.mergedAt);
  if (prState === 'merged' || prState === 'closed') {
    return {
      repoFullName: ref.repoFullName,
      prNumber: ref.prNumber,
      headSha: pr.headRefOid,
      prState,
      aggregateBucket: 'pending',
      checks: [],
      ...(pr.mergedBy?.login ? { mergedByLogin: pr.mergedBy.login } : {}),
    };
  }

  const rollupContext = pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts;
  if (rollupContext?.pageInfo?.hasNextPage) {
    log.warn(`[ci-status] ${key} has more than 100 rollup contexts; using the exact single-PR fallback`);
    return fetchPrCiStatus(ref.repoFullName, ref.prNumber, log, options);
  }
  const contexts = graphQlRollup(pr);
  const rollup = contexts.map((context) => ({
    status: context.__typename === 'StatusContext' ? context.state : context.status,
    conclusion: context.__typename === 'StatusContext' ? '' : (context.conclusion ?? ''),
    __typename: context.__typename,
  }));
  const aggregateBucket = computeAggregateBucket(rollup);
  let checks = contexts.map(mapGraphQlCheck);
  if (aggregateBucket === 'fail') {
    checks = (await fetchRequiredFailingChecks(ref.repoFullName, ref.prNumber, options)) ?? checks;
    checks = await enrichGitHubExecutionFailures({
      repoFullName: ref.repoFullName,
      headSha: pr.headRefOid,
      checks,
      ghApiJson: (path) => ghApiJson(path, options),
      warn: (message) => log.warn(message),
    });
  }
  return {
    repoFullName: ref.repoFullName,
    prNumber: ref.prNumber,
    headSha: pr.headRefOid,
    prState,
    aggregateBucket,
    checkRollup: contexts.length === 0 ? 'empty' : 'present',
    checks,
  };
}

/**
 * One GraphQL process reads every tracked PR's state and status rollup.
 * Failed checks still use the existing typed REST enrichment; ordinary pass /
 * pending polls no longer spawn one or two `gh` processes per tracked PR.
 */
export async function fetchPrCiStatuses(
  targets: readonly PrCiStatusTarget[],
  log: MinimalLog,
  options: FetchPrCiStatusOptions = {},
): Promise<ReadonlyMap<string, CiPollResult | null>> {
  const results = new Map<string, CiPollResult | null>(
    targets.map((target) => [ciStatusTargetKey(target.repoFullName, target.prNumber), null]),
  );
  const { query, refs } = buildBatchQuery(targets);
  if (refs.length === 0) return results;

  let parsed: BatchGraphQlResponse | null;
  try {
    const { stdout } = await executeGh(['api', 'graphql', '-f', `query=${query}`], options);
    parsed = parseBatchGraphQlResponse(stdout);
  } catch (error) {
    options.signal?.throwIfAborted();
    parsed = parseBatchGraphQlResponse(stdoutFromExecError(error) ?? '');
    if (!parsed?.data) {
      log.warn(`[ci-status] batched GraphQL poll failed for ${refs.length} PRs: ${String(error)}`);
      return results;
    }
  }
  if (!parsed) {
    log.warn(`[ci-status] failed to parse batched GraphQL poll for ${refs.length} PRs`);
    return results;
  }
  if (parsed.errors) log.warn('[ci-status] batched GraphQL poll returned partial errors');

  for (const ref of refs) {
    options.signal?.throwIfAborted();
    const pr = parsed.data?.[ref.repoAlias]?.[ref.prAlias];
    if (!pr?.headRefOid) continue;
    results.set(ciStatusTargetKey(ref.repoFullName, ref.prNumber), await graphQlPrToPollResult(ref, pr, log, options));
  }
  return results;
}
