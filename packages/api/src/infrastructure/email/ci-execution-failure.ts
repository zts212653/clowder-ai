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

export async function enrichGitHubExecutionFailures(input: {
  repoFullName: string;
  headSha: string;
  checks: CiCheckDetail[];
  ghApiJson<T>(path: string): Promise<T>;
  warn(message: string): void;
}): Promise<CiCheckDetail[]> {
  if (!input.checks.some((check) => check.bucket === 'fail')) return input.checks;
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
    return Promise.all(
      input.checks.map(async (check) => {
        if (check.bucket !== 'fail') return check;
        const checkRun = checkRuns.find((candidate) => candidate.name === check.name);
        if (!checkRun) return check;
        const checkRunPath = `/repos/${input.repoFullName}/check-runs/${checkRun.id}`;
        const job = jobs.find(
          (candidate) => candidate.name === check.name && candidate.check_run_url?.endsWith(checkRunPath),
        );
        if (!job) return check;
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
        return executionFailure ? { ...check, executionFailure } : check;
      }),
    );
  } catch (error) {
    input.warn(
      `[ci-status] typed execution evidence unavailable for ${input.repoFullName}@${input.headSha}: ${String(error)}`,
    );
    return input.checks;
  }
}
