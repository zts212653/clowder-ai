/**
 * F140 Phase E.2 — github-feedback-filter post-cutover behavior.
 *
 * Rule B (authoritative-source skip) is DROPPED in E.2. Polling is now the
 * sole truth source for review feedback; skipping authoritative bots in
 * polling = data loss.
 *
 * Setup-noise (bot Codex setup guidance conversation comments) is handled
 * separately by `setup-noise-filter.ts` in polling gate, not by this filter.
 *
 * Only Rule A (self-authored skip) remains.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('createGitHubFeedbackFilter (post-E.2 cutover — Rule A only)', () => {
  it('skips self-authored comments and reviews (Rule A)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'zts212653' });
    assert.equal(filter.shouldSkipComment({ author: 'zts212653' }), true);
    assert.equal(filter.shouldSkipReview({ author: 'zts212653' }), true);
    assert.equal(filter.shouldSkipComment({ author: 'alice' }), false);
    assert.equal(filter.shouldSkipReview({ author: 'alice' }), false);
  });

  it('does NOT skip Codex bot inline comments (Rule B dropped — polling is sole source)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'me' });
    assert.equal(
      filter.shouldSkipComment({ author: 'chatgpt-codex-connector[bot]', commentType: 'inline' }),
      false,
      'bot inline must pass through — polling is sole source post-E.2',
    );
    assert.equal(
      filter.shouldSkipReview({ author: 'chatgpt-codex-connector[bot]' }),
      false,
      'bot review decision must pass through — polling is sole source post-E.2',
    );
  });

  it('does NOT skip Codex bot conversation comments (was always pass-through)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'me' });
    assert.equal(
      filter.shouldSkipComment({ author: 'chatgpt-codex-connector[bot]', commentType: 'conversation' }),
      false,
    );
  });

  it('does NOT skip non-self bots (dependabot, github-actions)', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'me' });
    assert.equal(filter.shouldSkipComment({ author: 'dependabot[bot]' }), false);
    assert.equal(filter.shouldSkipReview({ author: 'github-actions[bot]' }), false);
  });

  it('disables self-filter when selfGitHubLogin is undefined', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({});
    assert.equal(filter.shouldSkipComment({ author: 'zts212653' }), false);
    assert.equal(filter.shouldSkipReview({ author: 'anyone' }), false);
  });

  it('isSelfAuthored matches selfGitHubLogin only', async () => {
    const { createGitHubFeedbackFilter } = await import('../../dist/infrastructure/email/github-feedback-filter.js');
    const filter = createGitHubFeedbackFilter({ selfGitHubLogin: 'zts212653' });
    assert.equal(filter.isSelfAuthored('zts212653'), true);
    assert.equal(filter.isSelfAuthored('chatgpt-codex-connector[bot]'), false);
    assert.equal(filter.isSelfAuthored('alice'), false);
  });
});
