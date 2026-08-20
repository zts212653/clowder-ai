import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { fetchLatestIssueCommentCursor, maxGithubId } = await import('../dist/infrastructure/github/comment-cursors.js');

describe('GitHub comment cursor helpers', () => {
  it('maxGithubId ignores non-numeric ids and returns the highest numeric id', () => {
    assert.equal(maxGithubId([{ id: 10 }, { id: '11' }, { id: 42 }, { id: Number.NaN }, {}]), 42);
  });

  it('fetchLatestIssueCommentCursor seeds mature issue tracking from existing comments', async () => {
    const calls = [];
    const cursor = await fetchLatestIssueCommentCursor('owner/repo', 123, {
      ghToken: 'gh-token',
      fetcher: async (endpoint, options) => {
        calls.push({ endpoint, options });
        return [{ id: 10 }, { id: 42 }, { id: 7 }];
      },
    });

    assert.equal(cursor, 42);
    assert.deepEqual(calls, [
      {
        endpoint: '/repos/owner/repo/issues/123/comments',
        options: { ghToken: 'gh-token' },
      },
    ]);
  });
});
