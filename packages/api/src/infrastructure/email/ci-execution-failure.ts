import { GitHubRateLimitError } from '../github/request-budget.js';
import type { CiCheckDetail, CiExecutionFailure } from './ci-cd-contract.js';

export interface GitHubExecutionFailureEvidence {
  readonly checkConclusion: string;
  readonly jobConclusion: string;
  readonly runnerId: number | null;
  readonly steps: readonly unknown[];
  readonly annotationTexts: readonly string[];
}

interface GitHubCheckRunPayload {
  id: number;
  name: string;
  conclusion: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
}

interface GitHubActionsJobPayload {
  name: string;
  conclusion: string | null;
  runner_id: number | null;
  steps?: unknown[];
  check_run_url?: string;
}

export function classifyGitHubExecutionFailure(
  evidence: GitHubExecutionFailureEvidence,
): CiExecutionFailure | undefined {
  if (
    evidence.checkConclusion.toLowerCase() !== 'failure' ||
    evidence.jobConclusion.toLowerCase() !== 'failure' ||
    evidence.runnerId !== 0 ||
    evidence.steps.length !== 0
  ) {
    return undefined;
  }
  return evidence.annotationTexts.some((text) =>
    /(?:billing|spending[ -]?limit|payment required|account billing)/i.test(text),
  )
    ? 'billing_spending_limit_zero_step'
    : undefined;
}

interface ExecutionFailureInput {
  signal?: AbortSignal;
  repoFullName: string;
  headSha: string;
  checks: CiCheckDetail[];
  ghApiJson<T>(path: string): Promise<T>;
  warn(message: string): void;
}

/** Fail-open: a failed read returns the checks unclassified. */
export async function enrichGitHubExecutionFailures(input: ExecutionFailureInput): Promise<CiCheckDetail[]> {
  return (await readGitHubExecutionFailures(input)).checks;
}

/** As enrichGitHubExecutionFailures, saying whether every read it needed succeeded. */
export async function readGitHubExecutionFailures(
  input: ExecutionFailureInput,
): Promise<{ checks: CiCheckDetail[]; complete: boolean }> {
  if (!input.checks.some((check) => check.bucket === 'fail')) return { checks: input.checks, complete: true };
  try {
    const [checkRunsPayload, workflowRunsPayload] = await Promise.all([
      input.ghApiJson<{ check_runs?: GitHubCheckRunPayload[] }>(
        `repos/${input.repoFullName}/commits/${input.headSha}/check-runs?per_page=100`,
      ),
      input.ghApiJson<{ workflow_runs?: Array<{ id: number; conclusion: string | null }> }>(
        `repos/${input.repoFullName}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=100`,
      ),
    ]);
    const failedRuns = (workflowRunsPayload.workflow_runs ?? [])
      .filter((run) => run.conclusion === 'failure')
      .slice(0, 20);
    const jobsPayloads = await Promise.all(
      failedRuns.map((run) =>
        input.ghApiJson<{ jobs?: GitHubActionsJobPayload[] }>(
          `repos/${input.repoFullName}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        ),
      ),
    );
    const jobs = jobsPayloads.flatMap((payload) => payload.jobs ?? []);
    const checkRuns = checkRunsPayload.check_runs ?? [];
    const enriched: CiCheckDetail[] = [];
    // The shared credential owner is serialized; do not pre-queue an unbounded
    // annotation request for every failed check into its bounded admission queue.
    for (const check of input.checks) {
      input.signal?.throwIfAborted();
      if (check.bucket !== 'fail') {
        enriched.push(check);
        continue;
      }
      const checkRun = checkRuns.find((candidate) => candidate.name === check.name);
      if (!checkRun) {
        enriched.push(check);
        continue;
      }
      const checkRunPath = `/repos/${input.repoFullName}/check-runs/${checkRun.id}`;
      const job = jobs.find(
        (candidate) => candidate.name === check.name && candidate.check_run_url?.endsWith(checkRunPath),
      );
      if (!job) {
        enriched.push(check);
        continue;
      }
      // A job that actually ran cannot be the zero-step billing failure.
      // Annotation reads cannot change that typed execution fact.
      if (job.runner_id !== 0 || !Array.isArray(job.steps) || job.steps.length !== 0) {
        enriched.push(check);
        continue;
      }
      const annotations = await input.ghApiJson<Array<{ message?: string; title?: string }>>(
        `repos/${input.repoFullName}/check-runs/${checkRun.id}/annotations?per_page=100`,
      );
      const annotationTexts = [
        ...annotations.flatMap((annotation) => [annotation.title, annotation.message]),
        checkRun.output?.title,
        checkRun.output?.summary,
        checkRun.output?.text,
      ].filter((value): value is string => typeof value === 'string');
      const executionFailure = classifyGitHubExecutionFailure({
        checkConclusion: checkRun.conclusion ?? '',
        jobConclusion: job.conclusion ?? '',
        runnerId: job.runner_id,
        steps: Array.isArray(job.steps) ? job.steps : [],
        annotationTexts,
      });
      enriched.push(executionFailure ? { ...check, executionFailure } : check);
    }
    return { checks: enriched, complete: true };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof GitHubRateLimitError) throw error;
    input.warn(
      `[ci-status] typed execution evidence unavailable for ${input.repoFullName}@${input.headSha}: ${String(error)}`,
    );
    return { checks: input.checks, complete: false };
  }
}
