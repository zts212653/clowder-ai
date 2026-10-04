import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichGitHubExecutionFailures } from '../dist/infrastructure/email/ci-execution-failure.js';
import { executeGh, fetchPrCiStatus } from '../dist/infrastructure/email/ci-status-fetcher.js';
import { GitHubRateLimitError } from '../dist/infrastructure/github/request-budget.js';

test('many failed-check annotations stay within credential queue capacity', async () => {
  const checks = Array.from({ length: 100 }, (_, id) => ({ name: `check-${id}`, bucket: 'fail' }));
  const options = {
    ghToken: 'ci-many-annotations',
    execFileAsync: async (_file, args) => {
      const path = args[1];
      let value;
      if (path.includes('/commits/'))
        value = {
          check_runs: checks.map((check, id) => ({
            id,
            name: check.name,
            conclusion: 'failure',
            output: { summary: 'billing spending limit' },
          })),
        };
      else if (path.includes('/actions/runs?')) value = { workflow_runs: [{ id: 1, conclusion: 'failure' }] };
      else if (path.includes('/jobs?'))
        value = {
          jobs: checks.map((check, id) => ({
            name: check.name,
            conclusion: 'failure',
            runner_id: 0,
            steps: [],
            check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${id}`,
          })),
        };
      else value = [];
      return { stdout: JSON.stringify(value) };
    },
  };
  const result = await enrichGitHubExecutionFailures({
    repoFullName: 'owner/repo',
    headSha: 'a',
    checks,
    warn() {},
    async ghApiJson(path) {
      return JSON.parse((await executeGh(['api', path], options)).stdout);
    },
  });
  assert.equal(result.length, 100);
  assert(result.every((check) => check.executionFailure === 'billing_spending_limit_zero_step'));
});

for (const failureStage of ['required', 'details', 'enrichment'])
  test(`CI ${failureStage} quota aborts enrichment without a no-data fallback`, async () => {
    const calls = [];
    await assert.rejects(
      fetchPrCiStatus(
        'owner/repo',
        1,
        { warn() {} },
        {
          ghToken: `ci-quota-${failureStage}`,
          execFileAsync: async (_file, args) => {
            calls.push(args);
            if (args[0] === 'pr' && args[1] === 'view')
              return {
                stdout: JSON.stringify({
                  headRefOid: 'a',
                  state: 'OPEN',
                  mergedAt: null,
                  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
                }),
              };
            if (failureStage === 'details' && args.includes('--required')) return { stdout: '[]' };
            if (failureStage === 'enrichment' && args[0] === 'pr')
              return { stdout: JSON.stringify([{ name: 'gate', bucket: 'fail' }]) };
            throw Object.assign(new Error('secondary rate limit'), { stderr: 'HTTP 429\nretry-after: 60' });
          },
        },
      ),
      GitHubRateLimitError,
    );
    assert.equal(calls.length, failureStage === 'required' ? 2 : 3);
  });
