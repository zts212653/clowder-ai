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
});
