import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { matchGitHubTrackingEvents, normalizePrReviewEvent } = await import(
  '../dist/domains/github-signals/GitHubTrackingEvent.js'
);

const review = (state, author = 'SomeMaintainer') => ({
  id: 501,
  author,
  state,
  body: 'A few notes on the approach.',
  submittedAt: '2026-09-07T00:00:00Z',
});

/*
 * codex R28: a formal verdict is authoritative no matter who it name-drops.
 *
 * `partOfBotConversation` was true for ANY body mentioning a known bot, so a maintainer's
 * "agree with @codex; requesting changes" was typed `pr_bot_interaction` — an event non-author
 * trackers have OFF by default. The authoritative decision then vanished silently, which A26
 * ranks strictly below extra noise.
 */
describe('F280 — a human decision is not bot chatter', () => {
  const mentioning = (state, author = 'SomeMaintainer') => ({
    id: 777,
    author,
    state,
    body: 'agree with @codex; requesting changes',
    submittedAt: '2026-09-07T00:00:00Z',
  });

  for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) {
    it(`a human ${state} that mentions a bot stays a decision`, () => {
      assert.equal(normalizePrReviewEvent(mentioning(state)).type, 'pr_review_decision_changed');
    });
  }

  it('a decision written BY the bot is still bot conversation', () => {
    const fromBot = mentioning('CHANGES_REQUESTED', 'chatgpt-codex-connector[bot]');
    assert.equal(normalizePrReviewEvent(fromBot).type, 'pr_bot_interaction');
  });

  it('a COMMENTED review mentioning a bot is still bot conversation', () => {
    // Mentioning stays the muting affordance where there is no verdict to lose.
    assert.equal(normalizePrReviewEvent(mentioning('COMMENTED')).type, 'pr_bot_interaction');
  });
});

describe('F280 — the review normalizer honours the decision states', () => {
  // Codex P2 on #1394. #1392 defines review_decision as "approve / request changes / dismiss",
  // and the normalizer labelled every non-bot review a decision regardless of state. Fixing
  // only the predicate matcher left this half undone: the event still ARRIVES as a decision,
  // so a subscriber that keeps review_decision but drops the comment surfaces still sees it.
  it('a plain COMMENTED review is not a decision event', () => {
    assert.notEqual(normalizePrReviewEvent(review('COMMENTED')).type, 'pr_review_decision_changed');
  });

  it('a plain COMMENTED review travels on the comment surface', () => {
    assert.equal(normalizePrReviewEvent(review('COMMENTED')).type, 'pr_conversation_comment_added');
  });

  it('keeps the review frontier so cursors do not cross', () => {
    // Audience is decided by type; "what have I seen" is decided by source. A COMMENTED review
    // is still a review record, so it must advance the review cursor, not the comment one.
    assert.equal(normalizePrReviewEvent(review('COMMENTED')).source, 'pr_review');
  });

  for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) {
    it(`${state} stays a decision`, () => {
      assert.equal(normalizePrReviewEvent(review(state)).type, 'pr_review_decision_changed');
    });
  }
});

describe('F280 — an in-place dismissal is a new decision version, not a new review id', () => {
  const baseline = {
    capturedAt: 1,
    headSha: 'head-1',
    review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 501 },
  };
  const when = [{ kind: 'pr_review_decision_changed' }];

  it('matches a dismissal whose already-seen review id stayed unchanged', () => {
    const event = normalizePrReviewEvent({
      ...review('DISMISSED'),
      previousState: 'APPROVED',
    });
    const matches = matchGitHubTrackingEvents(when, baseline, [event]);
    assert.equal(matches.length, 1);
    assert.match(matches[0].delta, /formal review DISMISSED #501/);
  });

  it('does not replay an old dismissed review without a known state transition', () => {
    const event = normalizePrReviewEvent(review('DISMISSED'));
    assert.deepEqual(matchGitHubTrackingEvents(when, baseline, [event]), []);
  });
});
