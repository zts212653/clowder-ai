import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { matchGitHubTrackingEvents } = await import('../dist/domains/github-signals/GitHubTrackingEvent.js');

const PR_AUTHOR = 'PrAuthor';
const ME = 'RegisteringCat';

const baseline = Object.freeze({
  capturedAt: 100,
  headSha: 'aaaa1111',
  review: { inlineCommentCursor: 0, conversationCommentCursor: 10, decisionCursor: 0 },
});

const comment = (id, author) => ({
  type: 'pr_conversation_comment_added',
  id,
  source: 'pr_conversation_comment',
  author,
  summary: `conversation comment #${id} by ${author}`,
});

const when = [{ kind: 'pr_conversation_comment_added' }];

describe('F280 A30 — a non-author only hears the PR author', () => {
  // The operator's journey B: "有且只有 A 的 comment 回复通知到它". Expressing the role
  // difference as a subscription default (bot_interaction: 'author') cannot say this — a
  // maintainer stays subscribed to conversation_comment and therefore hears every third
  // party. The audience decision has to reach the filter itself.
  it('A30: a third party does not wake a non-author tracker', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(11, 'SomeoneElse')], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.deepEqual(matches, [], 'a maintainer must not be woken by an unrelated third party');
  });

  it('A26: the PR author still wakes a non-author tracker', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(12, PR_AUTHOR)], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1, 'muting the real signal is worse than any noise');
  });

  it('the PR author hears everyone except themselves', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(13, 'SomeoneElse'), comment(14, PR_AUTHOR)], {
      audience: { selfLogin: PR_AUTHOR, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1, 'the author hears third parties');
    assert.match(matches[0].delta, /SomeoneElse/);
  });
});
