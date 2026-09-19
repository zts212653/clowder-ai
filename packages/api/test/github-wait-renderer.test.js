import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyGitHubReviewLoopBrake,
  REVIEW_LOOP_BRAKE_NEXT_STEP,
  REVIEW_LOOP_HISTORY_WARN_NEXT_STEP,
  renderGitHubWaitOutcome,
} from '../dist/domains/github-signals/github-wait-renderer.js';

function review(id, state = 'CHANGES_REQUESTED', author = `reviewer-${id}`) {
  return { id, state, author };
}

describe('external GitHub review-loop R4 brake', () => {
  it('pauses only on the transition to four formal non-author changes-requested reviews', () => {
    const history = [review(1), review(2), review(3), review(4)];
    assert.deepEqual(classifyGitHubReviewLoopBrake(history, [4], 'pr-author'), {
      kind: 'pause_once',
      formalChangesRequested: 4,
    });
    assert.deepEqual(classifyGitHubReviewLoopBrake([...history, review(5)], [5], 'pr-author'), {
      kind: 'continue',
      formalChangesRequested: 5,
    });
    assert.deepEqual(
      classifyGitHubReviewLoopBrake([...history, review(6, 'CHANGES_REQUESTED', 'pr-author')], [6], 'pr-author'),
      {
        kind: 'continue',
        formalChangesRequested: 4,
      },
    );
  });

  it('renders the accepted-source reset and Finding Pattern Summary without inventing a round object', () => {
    const content = renderGitHubWaitOutcome({
      v: 1,
      outcomeId: 'outcome',
      generation: 1,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 1,
      delivery: 'pending',
      matched: [{ kind: 'pr_review_decision_changed', delta: 'review pending → CHANGES_REQUESTED' }],
      nextStep: REVIEW_LOOP_BRAKE_NEXT_STEP,
    });
    assert.match(content, /automatic re-request paused once/i);
    assert.match(content, /accepted source/i);
    assert.match(content, /Finding Pattern Summary/i);
    assert.doesNotMatch(content, /round|reset object|lease|verdict/i);
  });

  it('renders history-unavailable as warn-open and keeps the original next step', () => {
    const content = renderGitHubWaitOutcome({
      v: 1,
      outcomeId: 'outcome',
      generation: 1,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 1,
      delivery: 'pending',
      nextStep: `${REVIEW_LOOP_HISTORY_WARN_NEXT_STEP}Fix and request review`,
    });
    assert.match(content, /history unavailable.*warn-open/i);
    assert.match(content, /Next: Fix and request review/);
  });
  /*
   * #1392: every delivery must say what happens next to the tracking itself. The failures the issue
   * opened with were all silent about exactly this — tracking had ended, and nothing said so.
   */
  describe('the tracking status line', () => {
    const base = {
      v: 1,
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      generation: 4,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 4 },
      reason: 'matched',
      at: 700,
      delivery: 'pending',
      matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaa111 → bbbb222' }],
      nextStep: 'Re-lock the exact HEAD.',
    };

    it('says tracking continues after a renewal', async () => {
      const { renderGitHubWaitOutcome } = await import('../dist/domains/github-signals/github-wait-renderer.js');
      assert.match(renderGitHubWaitOutcome({ ...base, renewal: 'rearmed' }), /Tracking continues/);
    });

    it('says loudly that tracking was not rearmed when the next generation could not be installed', async () => {
      const { renderGitHubWaitOutcome } = await import('../dist/domains/github-signals/github-wait-renderer.js');
      const content = renderGitHubWaitOutcome({ ...base, renewal: 'rearm_failed' });
      assert.match(content, /tracking not rearmed/i);
      assert.doesNotMatch(content, /Tracking continues/, 'a failed rearm must never read as success');
    });

    it('says a single-fire wait has ended', async () => {
      const { renderGitHubWaitOutcome } = await import('../dist/domains/github-signals/github-wait-renderer.js');
      assert.match(renderGitHubWaitOutcome(base), /Tracking ended/);
    });

    it('delivers an expiry as its own terminal notice rather than a satisfied wait', async () => {
      const { renderGitHubWaitOutcome } = await import('../dist/domains/github-signals/github-wait-renderer.js');
      const content = renderGitHubWaitOutcome({
        ...base,
        outcomeId: 'wait:pr:owner/repo#7:g4:expired',
        reason: 'expired',
        matched: undefined,
      });
      assert.match(content, /expired/i);
      assert.doesNotMatch(content, /wait satisfied/, 'nothing was satisfied; the deadline passed');
      assert.match(content, /Tracking ended/);
    });

    it('an expiry lists what its final poll observed, and only an empty poll says nothing matched', async () => {
      const { renderGitHubWaitOutcome } = await import('../dist/domains/github-signals/github-wait-renderer.js');
      const expired = { ...base, outcomeId: 'wait:pr:owner/repo#7:g4:expired', reason: 'expired' };

      const content = renderGitHubWaitOutcome({
        ...expired,
        matched: [{ kind: 'pr_conversation_comment_added', delta: 'conversation comment #31 by maintainer' }],
        terminalSubjectState: 'merged',
      });
      assert.match(content, /conversation comment #31 by maintainer/);
      assert.match(content, /PR state: merged/);
      assert.doesNotMatch(content, /before anything matched/, 'something did match');

      assert.match(renderGitHubWaitOutcome({ ...expired, matched: undefined }), /before anything matched/);
    });
  });
});
