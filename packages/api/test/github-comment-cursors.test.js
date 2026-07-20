import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { fetchInitialPrTrackingBoundary, fetchLatestIssueCommentCursor, maxGithubId } = await import(
  '../dist/infrastructure/github/comment-cursors.js'
);

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

  it('fetchInitialPrTrackingBoundary starts review cursors at zero while preserving the CI boundary', async () => {
    const calls = [];
    const boundary = await fetchInitialPrTrackingBoundary('owner/repo', 456, {
      fetchCiStatus: async (repoFullName, prNumber) => {
        calls.push({ repoFullName, prNumber });
        return { headSha: 'abc123', aggregateBucket: 'fail' };
      },
    });

    assert.deepEqual(boundary, {
      review: {
        lastCommentCursor: 0,
        lastInlineCommentCursor: 0,
        lastConversationCommentCursor: 0,
        lastDecisionCursor: 0,
      },
      ci: {
        headSha: 'abc123',
        lastFingerprint: 'abc123:fail',
        lastBucket: 'fail',
      },
    });
    assert.deepEqual(calls, [{ repoFullName: 'owner/repo', prNumber: 456 }]);
  });
});
