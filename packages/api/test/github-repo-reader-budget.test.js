import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPaginated } from '../dist/infrastructure/github/fetch-paginated.js';
import { createGitHubRepoPollReaders } from '../dist/infrastructure/github/repo-poll-readers.js';
import { GitHubRateLimitError } from '../dist/infrastructure/github/request-budget.js';

const quota = () => Object.assign(new Error('API rate limit exceeded'), { stderr: 'HTTP 429\nretry-after: 60' });
test('every repository poll reader observes the same credential fence and leaves other credentials usable', async () => {
  let calls = 0;
  const readers = createGitHubRepoPollReaders({
    getGitHubToken: () => 'repo-reader-fence',
    execFileAsync: async () => {
      calls++;
      throw quota();
    },
  });
  await assert.rejects(readers.fetchOpenPRs('owner/repo'), GitHubRateLimitError);
  for (const read of [
    () => readers.fetchOpenIssues('owner/repo'),
    () => readers.fetchRepoComments('owner/repo', '2026-10-01T00:00:00Z'),
    () => readers.fetchIssueState('owner/repo', 1),
    () => readers.fetchPrState('owner/repo', 1),
  ])
    await assert.rejects(read(), GitHubRateLimitError);
  await assert.rejects(
    fetchPaginated('/repos/owner/repo/issues/1/comments', {
      ghToken: 'repo-reader-fence',
      execFileAsync: async () => {
        calls++;
        return { stdout: '' };
      },
    }),
    GitHubRateLimitError,
  );
  assert.equal(calls, 1);
  const other = createGitHubRepoPollReaders({
    getGitHubToken: () => 'repo-reader-other',
    execFileAsync: async () => {
      calls++;
      return { stdout: '{"state":"closed","closed_at":"now"}' };
    },
  });
  assert.equal((await other.fetchIssueState('owner/repo', 1)).state, 'closed');
  assert.equal(calls, 2);
});
test('repository pages remain complete and cancellation cannot start the next page', async () => {
  let calls = 0;
  const controller = new AbortController();
  let cancel = false;
  const entry = (n) => ({
    number: n,
    title: `item-${n}`,
    html_url: `https://github.com/owner/repo/pull/${n}`,
    user: { login: 'alice' },
    author_association: 'CONTRIBUTOR',
    draft: false,
  });
  const readers = createGitHubRepoPollReaders({
    getGitHubToken: () => 'repo-reader-pages',
    execFileAsync: async (_file, args) => {
      calls++;
      const items =
        new URL(args[1], 'https://api.github.com').searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, i) => entry(i + 1))
          : [entry(101)];
      if (cancel) controller.abort(new Error('repository reader stopped'));
      return { stdout: items.map(JSON.stringify).join('\n') };
    },
  });
  const results = await readers.fetchOpenPRs('owner/repo');
  assert.equal(results.length, 101);
  assert.equal(results[100].user, 'alice');
  assert.equal(calls, 2);
  cancel = true;
  await assert.rejects(readers.fetchOpenPRs('owner/repo', controller.signal), /repository reader stopped/);
  assert.equal(calls, 3);
});
