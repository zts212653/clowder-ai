import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPrCiStatuses } from '../dist/infrastructure/email/ci-status-batch-fetcher.js';
import { fetchPrCiStatus } from '../dist/infrastructure/email/ci-status-fetcher.js';
import { fetchPaginated } from '../dist/infrastructure/github/fetch-paginated.js';
import { GitHubRateLimitError } from '../dist/infrastructure/github/request-budget.js';

const log = { warn() {} };
const target = { repoFullName: 'owner/repo', prNumber: 1 };
function exhausted() {
  return Object.assign(new Error('API rate limit exceeded'), {
    stderr: `HTTP 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${Math.ceil(Date.now() / 1000) + 60}`,
  });
}
function batch() {
  return {
    stdout: JSON.stringify({
      data: { r0: { p0: { headRefOid: 'a', state: 'OPEN', mergedAt: null, mergedBy: null, commits: { nodes: [] } } } },
    }),
  };
}
test('comment quota fences both CI batch and single-PR readers before subprocess launch', async () => {
  const ghToken = 'comment-to-ci-quota';
  let calls = 0;
  await assert.rejects(
    fetchPaginated('/repos/owner/repo/issues/1/comments', {
      ghToken,
      execFileAsync: async () => {
        calls++;
        throw exhausted();
      },
    }),
    GitHubRateLimitError,
  );
  await assert.rejects(
    fetchPrCiStatuses([target], log, {
      ghToken,
      execFileAsync: async () => {
        calls++;
        return batch();
      },
    }),
    GitHubRateLimitError,
  );
  await assert.rejects(
    fetchPrCiStatus('owner/repo', 1, log, {
      ghToken,
      execFileAsync: async () => {
        calls++;
        return { stdout: '{}' };
      },
    }),
    GitHubRateLimitError,
  );
  assert.equal(calls, 1);
});
test('CI quota fences comments, another credential continues, and no empty CI projection escapes', async () => {
  const ghToken = 'ci-to-comment-quota';
  let calls = 0;
  await assert.rejects(
    fetchPrCiStatuses([target], log, {
      ghToken,
      execFileAsync: async () => {
        calls++;
        throw exhausted();
      },
    }),
    GitHubRateLimitError,
  );
  await assert.rejects(
    fetchPaginated('/repos/owner/repo/issues/1/comments', {
      ghToken,
      execFileAsync: async () => {
        calls++;
        return { stdout: '' };
      },
    }),
    GitHubRateLimitError,
  );
  const other = await fetchPrCiStatuses([target], log, {
    ghToken: 'ci-other-credential',
    execFileAsync: async () => {
      calls++;
      return batch();
    },
  });
  assert.equal(other.get('owner/repo#1').headSha, 'a');
  assert.equal(calls, 2);
});

test('HTTP quota headers do not destroy healthy partial GraphQL data on a non-quota failure', async () => {
  const partial = {
    data: {
      r0: { p0: { headRefOid: 'preserved', state: 'OPEN', mergedAt: null, mergedBy: null, commits: { nodes: [] } } },
    },
    errors: [{ type: 'NOT_FOUND' }],
  };
  const result = await fetchPrCiStatuses([target], log, {
    ghToken: 'ci-partial-fixture',
    execFileAsync: async () => {
      throw Object.assign(new Error('gh GraphQL NOT_FOUND'), {
        stdout: `HTTP/2.0 200 OK\r\nx-ratelimit-remaining: 42\r\n\r\n${JSON.stringify(partial)}`,
      });
    },
  });
  assert.equal(result.get('owner/repo#1')?.headSha, 'preserved');
});
