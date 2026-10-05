import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPaginated } from '../dist/infrastructure/github/fetch-paginated.js';
import { GitHubRateLimitError } from '../dist/infrastructure/github/request-budget.js';
import { createRepoActivityTemplate } from '../dist/infrastructure/scheduler/templates/repo-activity.js';

test('repo activity cannot bypass a credential fence via direct HTTP', async () => {
  const ghToken = 'activity-fence';
  let calls = 0,
    delivered = 0;
  await assert.rejects(
    fetchPaginated('/repos/owner/repo/issues/1/comments', {
      ghToken,
      execFileAsync: async () => {
        calls++;
        throw Object.assign(new Error('secondary rate limit'), { stderr: 'HTTP 429\nretry-after: 60' });
      },
    }),
    GitHubRateLimitError,
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => [] };
  };
  try {
    const template = createRepoActivityTemplate({
      getGitHubToken: () => ghToken,
      execFileAsync: async () => {
        calls++;
        return { stdout: '[]' };
      },
    });
    const spec = template.createSpec('activity-fence', {
      trigger: { type: 'interval', ms: 1 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: 't',
    });
    await assert.rejects(
      spec.run.execute({ repo: 'owner/repo', since: null }, 'thread-t', {
        deliver: async () => {
          delivered++;
        },
      }),
      GitHubRateLimitError,
    );
    assert.equal(calls, 1);
    assert.equal(delivered, 0);
  } finally {
    globalThis.fetch = original;
  }
});
