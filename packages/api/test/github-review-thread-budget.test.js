import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGitHubReviewThreads } from '../dist/infrastructure/github/fetch-review-threads.js';

function response(id, repo = 'owner/repo') {
  return {
    stdout: JSON.stringify({
      data: {
        node: {
          id,
          isResolved: false,
          pullRequest: { number: 1, repository: { nameWithOwner: repo } },
          comments: { nodes: [{ id: `comment-${id}` }] },
        },
      },
    }),
  };
}

test('a review-thread set larger than the credential queue remains complete', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `thread-${i}`);
  let calls = 0;
  const results = await fetchGitHubReviewThreads('owner/repo', 1, ids, {
    ghToken: 'review-thread-large-fixture',
    execFileAsync: async (_file, args) => {
      calls++;
      return response(args.find((arg) => arg.startsWith('id=')).slice(3));
    },
  });
  assert.deepEqual(
    results.map((row) => row.reviewThreadId),
    ids,
  );
  assert.equal(calls, 130);
});

test('review-thread cancellation stops before the next request and membership remains verified', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchGitHubReviewThreads('owner/repo', 1, ['first', 'second'], {
      ghToken: 'review-thread-cancel-fixture',
      signal: controller.signal,
      execFileAsync: async () => {
        calls++;
        controller.abort(new Error('client left'));
        return response('first');
      },
    }),
    /client left/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchGitHubReviewThreads('owner/repo', 1, ['foreign'], {
      ghToken: 'review-thread-owner-fixture',
      execFileAsync: async () => response('foreign', 'stranger/repo'),
    }),
    /does not belong/,
  );
});
