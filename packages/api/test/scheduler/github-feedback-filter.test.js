import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('createGitHubFeedbackFilter', () => {
  it('skips self-authored comments and reviews', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'zts212653', authoritativeReviewLogins: [] });
    assert.equal(filter.shouldSkipComment({ author: 'zts212653' }), true);
    assert.equal(filter.shouldSkipReview({ author: 'zts212653' }), true);
    assert.equal(filter.shouldSkipComment({ author: 'alice' }), false);
    assert.equal(filter.shouldSkipReview({ author: 'alice' }), false);
  });

  it('skips authoritative review bot', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({
      selfGitHubLogin: 'me',
      authoritativeReviewLogins: ['chatgpt-codex-connector[bot]'],
    });
    assert.equal(filter.shouldSkipComment({ author: 'chatgpt-codex-connector[bot]' }), true);
    assert.equal(filter.shouldSkipReview({ author: 'chatgpt-codex-connector[bot]' }), true);
  });

  it('does NOT skip non-authoritative bots', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({
      selfGitHubLogin: 'me',
      authoritativeReviewLogins: ['chatgpt-codex-connector[bot]'],
    });
    assert.equal(filter.shouldSkipComment({ author: 'dependabot[bot]' }), false);
    assert.equal(filter.shouldSkipReview({ author: 'github-actions[bot]' }), false);
  });

  it('disables self-filter when selfGitHubLogin is undefined', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ authoritativeReviewLogins: ['chatgpt-codex-connector[bot]'] });
    // self-filter disabled → no false negatives
    assert.equal(filter.shouldSkipComment({ author: 'zts212653' }), false);
    // authoritative bot still works
    assert.equal(filter.shouldSkipComment({ author: 'chatgpt-codex-connector[bot]' }), true);
  });

  // ── Rule C: email watcher uses isSelfAuthored (Rule A only) ──

  it('email watcher skips self-authored review via isSelfAuthored (Rule C)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'zts212653', authoritativeReviewLogins: [] });
    // Email watcher uses isSelfAuthored — same as github-review-bootstrap.ts
    assert.equal(filter.isSelfAuthored('zts212653'), true, 'self-authored → skip in email channel');
    assert.equal(filter.isSelfAuthored('alice'), false, 'external → pass through in email channel');
  });

  it('email watcher does NOT skip authoritative bot — email IS the authoritative source (Rule C)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({
      selfGitHubLogin: 'zts212653',
      authoritativeReviewLogins: ['chatgpt-codex-connector[bot]'],
    });
    // Email channel IS the authoritative source for Codex bot reviews.
    // isSelfAuthored must return false for bot — only Rule A applies in email channel.
    assert.equal(
      filter.isSelfAuthored('chatgpt-codex-connector[bot]'),
      false,
      'bot is NOT self-authored → email channel keeps it',
    );
    // But F140 (shouldSkipReview) DOES skip it
    assert.equal(
      filter.shouldSkipReview({ author: 'chatgpt-codex-connector[bot]' }),
      true,
      'F140 skips authoritative bot',
    );
  });
});
