import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { applyReviewDecisionStateUpdate, applyReviewDecisionStateUpdateWithReceipt } = await import(
  '../dist/domains/github-signals/ReviewDecisionStateUpdate.js'
);

describe('F280 conditional formal-review state updates', () => {
  it('does not apply a stale per-review transition after the expected state changed', () => {
    const current = {
      review: { activeDecisionStatesByReviewId: { 31: 'CHANGES_REQUESTED' } },
    };

    const updated = applyReviewDecisionStateUpdate(current, {
      kind: 'transitions',
      transitions: [{ reviewId: '31', expectedState: 'APPROVED', nextState: null }],
    });

    assert.equal(updated, current, 'a rejected transition does not manufacture a replacement snapshot');
    assert.deepEqual(updated.review.activeDecisionStatesByReviewId, { 31: 'CHANGES_REQUESTED' });
  });

  it('reports only transitions that actually changed the latest CAS candidate', () => {
    const current = {
      review: { activeDecisionStatesByReviewId: { 31: 'APPROVED', 32: 'CHANGES_REQUESTED' } },
    };

    const result = applyReviewDecisionStateUpdateWithReceipt(current, {
      kind: 'transitions',
      transitions: [
        { reviewId: '31', expectedState: 'APPROVED', nextState: null },
        { reviewId: '32', expectedState: 'APPROVED', nextState: null },
      ],
    });

    assert.deepEqual(result.state.review.activeDecisionStatesByReviewId, { 32: 'CHANGES_REQUESTED' });
    assert.deepEqual([...result.appliedTransitionReviewIds], ['31']);
  });

  it('initializes a legacy snapshot exactly once', () => {
    const initializer = {
      kind: 'initialize_if_absent',
      states: { 31: 'APPROVED' },
    };

    assert.deepEqual(applyReviewDecisionStateUpdate({ review: {} }, initializer), {
      review: { activeDecisionStatesByReviewId: { 31: 'APPROVED' } },
    });

    const current = { review: { activeDecisionStatesByReviewId: {} } };
    assert.equal(
      applyReviewDecisionStateUpdate(current, initializer),
      current,
      'a delayed legacy initializer cannot restore a state after a newer observation initialized it',
    );
  });
});
