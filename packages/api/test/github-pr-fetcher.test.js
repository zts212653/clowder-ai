import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

describe('mapGitHubPr', () => {
  let mapGitHubPr;
  before(async () => {
    ({ mapGitHubPr } = await import('../dist/domains/community/GitHubPrFetcher.js'));
  });

  test('open PR with no reviews → unreplied', () => {
    const result = mapGitHubPr(
      {
        number: 1,
        title: 'T',
        state: 'open',
        merged_at: null,
        user: 'alice',
        head_sha: 'a1',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [],
    );
    assert.equal(result.state, 'open');
    assert.equal(result.replyState, 'unreplied');
  });

  test('open PR with non-author review → replied', () => {
    const result = mapGitHubPr(
      {
        number: 2,
        title: 'T',
        state: 'open',
        merged_at: null,
        user: 'alice',
        head_sha: 'a2',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [{ user: 'bob', state: 'APPROVED', commit_id: 'a2' }],
    );
    assert.equal(result.replyState, 'replied');
    assert.equal(result.lastReviewedSha, 'a2');
  });

  test('open PR with only author review → unreplied', () => {
    const result = mapGitHubPr(
      {
        number: 3,
        title: 'T',
        state: 'open',
        merged_at: null,
        user: 'alice',
        head_sha: 'a3',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [{ user: 'alice', state: 'COMMENTED', commit_id: 'a3' }],
    );
    assert.equal(result.replyState, 'unreplied');
  });

  test('replied PR with new head SHA → has-new-activity', () => {
    const result = mapGitHubPr(
      {
        number: 4,
        title: 'T',
        state: 'open',
        merged_at: null,
        user: 'alice',
        head_sha: 'new-sha',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [{ user: 'bob', state: 'CHANGES_REQUESTED', commit_id: 'old-sha' }],
    );
    assert.equal(result.replyState, 'has-new-activity');
    assert.equal(result.lastReviewedSha, 'old-sha');
  });

  test('closed PR with merged_at → merged', () => {
    const result = mapGitHubPr(
      {
        number: 5,
        title: 'T',
        state: 'closed',
        merged_at: '2026-01-01',
        user: 'alice',
        head_sha: 'a5',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [],
    );
    assert.equal(result.state, 'merged');
  });

  test('closed PR without merged_at → closed', () => {
    const result = mapGitHubPr(
      {
        number: 6,
        title: 'T',
        state: 'closed',
        merged_at: null,
        user: 'alice',
        head_sha: 'a6',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [],
    );
    assert.equal(result.state, 'closed');
  });

  test('closed/merged PR replyState defaults to replied', () => {
    const result = mapGitHubPr(
      {
        number: 7,
        title: 'T',
        state: 'closed',
        merged_at: '2026-01-01',
        user: 'alice',
        head_sha: 'a7',
        draft: false,
        labels: [],
        updated_at: '',
      },
      [],
    );
    assert.equal(result.replyState, 'replied');
  });
});
