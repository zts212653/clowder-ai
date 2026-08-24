// @ts-check
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { fetchPrCiStatuses } from '../dist/infrastructure/email/ci-status-batch-fetcher.js';

function graphQlPr({ sha, contexts, hasNextPage = false }) {
  return {
    headRefOid: sha,
    state: 'OPEN',
    mergedAt: null,
    mergedBy: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: contexts, pageInfo: { hasNextPage } },
            },
          },
        },
      ],
    },
  };
}

function checkRun(name, conclusion) {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    detailsUrl: `https://example.test/${name}`,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  };
}

describe('fetchPrCiStatuses batch failure isolation', () => {
  it('passes cancellation to gh and does not swallow an abort as an empty poll', async () => {
    const controller = new AbortController();
    let commandCount = 0;

    const pending = fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        signal: controller.signal,
        async execFileAsync(_file, _args, options) {
          commandCount++;
          assert.equal(options.signal, controller.signal);
          controller.abort(new Error('scheduler timeout'));
          throw controller.signal.reason;
        },
      },
    );

    await assert.rejects(pending, /scheduler timeout/);
    assert.equal(commandCount, 1, 'abort must not start fallback or enrichment gh commands');
  });

  it('keeps healthy PR data when gh exits 1 with partial GraphQL data on stdout', async () => {
    const warnings = [];
    const partial = {
      data: {
        r0: {
          p0: graphQlPr({ sha: 'a'.repeat(40), contexts: [checkRun('gate', 'SUCCESS')] }),
          p1: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', path: ['r0', 'p1'] }],
    };
    const ghError = Object.assign(new Error('gh exited with code 1'), { stdout: JSON.stringify(partial) });

    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 999_999 },
      ],
      { warn: (message) => warnings.push(String(message)) },
      {
        async execFileAsync() {
          throw ghError;
        },
      },
    );

    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#999999'), null);
    assert.ok(warnings.some((message) => message.includes('partial errors')));
  });

  it('preserves required-check narrowing when a required check fails', async () => {
    const commands = [];
    const results = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          commands.push([...args]);
          const command = args.join(' ');
          if (command.startsWith('api graphql ')) {
            return {
              stdout: JSON.stringify({
                data: {
                  r0: {
                    p0: graphQlPr({
                      sha: 'b'.repeat(40),
                      contexts: [checkRun('required-gate', 'FAILURE'), checkRun('optional-lint', 'FAILURE')],
                    }),
                  },
                },
              }),
            };
          }
          if (command.startsWith('pr checks ') && command.includes('--required')) {
            return {
              stdout: JSON.stringify([
                {
                  name: 'required-gate',
                  bucket: 'fail',
                  link: 'https://example.test/required-gate',
                  workflow: 'CI',
                },
              ]),
            };
          }
          if (command.includes('/check-runs?')) return { stdout: JSON.stringify({ check_runs: [] }) };
          if (command.includes('/actions/runs?')) return { stdout: JSON.stringify({ workflow_runs: [] }) };
          throw new Error(`unexpected gh command: ${command}`);
        },
      },
    );

    assert.deepEqual(
      results.get('owner/repo#7')?.checks.map((check) => check.name),
      ['required-gate'],
    );
    assert.ok(commands.some((args) => args.includes('--required')));
  });

  it('falls back to the exact single-PR reader when rollup contexts exceed one page', async () => {
    const commands = [];
    const results = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          commands.push([...args]);
          const command = args.join(' ');
          if (command.startsWith('api graphql ')) {
            return {
              stdout: JSON.stringify({
                data: {
                  r0: {
                    p0: graphQlPr({
                      sha: 'c'.repeat(40),
                      contexts: [
                        {
                          __typename: 'CheckRun',
                          name: 'gate',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                        },
                      ],
                      hasNextPage: true,
                    }),
                  },
                },
              }),
            };
          }
          if (command.startsWith('pr view ')) {
            return {
              stdout: JSON.stringify({
                headRefOid: 'c'.repeat(40),
                state: 'OPEN',
                mergedAt: null,
                mergedBy: null,
                statusCheckRollup: [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' }],
              }),
            };
          }
          throw new Error(`unexpected gh command: ${command}`);
        },
      },
    );

    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pending');
    assert.ok(commands.some((args) => args[0] === 'pr' && args[1] === 'view'));
  });
});
