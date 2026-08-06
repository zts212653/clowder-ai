import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyPrReviewEventWaitCoverage } from '../dist/infrastructure/github/pr-review-event-wait-coverage.js';

const INPUT = {
  repoFullName: 'zts212653/cat-cafe',
  prNumber: 2856,
  triggerCommentId: 4936000000,
};

function execFixture({
  body = '@codex review',
  issueNumber = 2856,
  acceptedByCodex = true,
  reviewAlreadyPosted = false,
  inlineCommentAlreadyPosted = false,
  conversationCommentAlreadyPosted = false,
} = {}) {
  const feedbackResponses = new Map([
    [
      `repos/${INPUT.repoFullName}/pulls/${INPUT.prNumber}/comments?per_page=100`,
      inlineCommentAlreadyPosted ? 'chatgpt-codex-connector[bot]\tBot\t2026-07-11T08:55:08Z\n' : '',
    ],
    [
      `repos/${INPUT.repoFullName}/issues/${INPUT.prNumber}/comments?per_page=100`,
      conversationCommentAlreadyPosted ? 'chatgpt-codex-connector[bot]\tBot\t2026-07-11T08:55:08Z\n' : '',
    ],
    [
      `repos/${INPUT.repoFullName}/pulls/${INPUT.prNumber}/reviews?per_page=100`,
      reviewAlreadyPosted
        ? 'chatgpt-codex-connector[bot]\tBot\t2026-07-11T08:55:08Z\n'
        : 'chatgpt-codex-connector[bot]\tBot\t2026-07-11T08:45:00Z\n',
    ],
  ]);
  return async (_file, args) => {
    const endpoint = args[1];
    const feedbackResponse = feedbackResponses.get(endpoint);
    if (feedbackResponse !== undefined) {
      assert.ok(args.includes('--paginate'), 'feedback query must inspect every page');
      return { stdout: feedbackResponse };
    }
    if (endpoint.includes('/reactions?')) {
      assert.match(endpoint, /\?content=eyes&per_page=100$/);
      assert.ok(args.includes('--paginate'), 'reaction provenance query must inspect every page');
      const jq = args[args.indexOf('--jq') + 1];
      assert.match(jq, /chatgpt-codex-connector\[bot\]/);
      assert.match(jq, /ascii_downcase/);
      return { stdout: acceptedByCodex ? '0\n1\n' : '0\n0\n' };
    }
    return {
      stdout: `${JSON.stringify({
        id: INPUT.triggerCommentId,
        body,
        issue_url: `https://api.github.com/repos/zts212653/cat-cafe/issues/${issueNumber}`,
        created_at: '2026-07-11T08:47:43Z',
      })}\n`,
    };
  };
}

describe('F177 PR review event-wait coverage verifier', () => {
  test('same PR exact trigger + Codex connector EYES is covered', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture(),
        now: () => 1234,
      }),
      { covered: true, triggerCommentId: INPUT.triggerCommentId, observedAt: 1234 },
    );
  });

  test('EYES=0 is uncovered', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ acceptedByCodex: false }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'review_not_accepted',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('connector review posted after the exact trigger consumes the EYES lease', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ reviewAlreadyPosted: true }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'feedback_already_posted',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('connector inline comment posted after the exact trigger consumes the EYES lease', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ inlineCommentAlreadyPosted: true }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'feedback_already_posted',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('connector conversation comment posted after the exact trigger consumes the EYES lease', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ conversationCommentAlreadyPosted: true }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'feedback_already_posted',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('EYES from a non-Codex actor is uncovered', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ acceptedByCodex: false }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'review_not_accepted',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('comment belonging to another PR is uncovered without querying reactions', async () => {
    let calls = 0;
    const execFileAsync = async (...args) => {
      calls += 1;
      return execFixture({ issueNumber: 9999 })(...args);
    };
    const result = await verifyPrReviewEventWaitCoverage(INPUT, { execFileAsync, now: () => 1234 });
    assert.deepEqual(result, {
      covered: false,
      reason: 'subject_mismatch',
      triggerCommentId: INPUT.triggerCommentId,
      observedAt: 1234,
    });
    assert.equal(calls, 1);
  });

  test('accepted trigger may carry bounded author context after the command', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ body: '@codex review\nplease also edit it' }),
        now: () => 1234,
      }),
      { covered: true, triggerCommentId: INPUT.triggerCommentId, observedAt: 1234 },
    );
  });

  test('narrative mention that does not begin with the command is uncovered', async () => {
    assert.deepEqual(
      await verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: execFixture({ body: 'Ready for @codex review' }),
        now: () => 1234,
      }),
      {
        covered: false,
        reason: 'not_review_trigger',
        triggerCommentId: INPUT.triggerCommentId,
        observedAt: 1234,
      },
    );
  });

  test('GitHub query error propagates so the route can fail closed', async () => {
    await assert.rejects(
      verifyPrReviewEventWaitCoverage(INPUT, {
        execFileAsync: async () => {
          throw new Error('gh unavailable');
        },
      }),
      /gh unavailable/,
    );
  });
});
