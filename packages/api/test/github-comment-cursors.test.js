import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { fetchLatestIssueCommentCursor } = await import('../dist/infrastructure/github/comment-cursors.js');

describe('GitHub comment cursor helpers', () => {
  it('#1053: fetchLatestIssueCommentCursor always returns 0 for new registrations', async () => {
    // New registrations have processed nothing yet — cursor starts at 0
    // so the first poll picks up all existing comments.
    const cursor = await fetchLatestIssueCommentCursor('owner/repo', 123, {
      ghToken: 'gh-token',
    });

    assert.equal(cursor, 0);
  });
});
