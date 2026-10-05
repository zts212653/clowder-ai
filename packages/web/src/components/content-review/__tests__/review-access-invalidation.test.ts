import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  invalidateArtifactReviewAccess,
  REVIEW_ACCESS_REVOKED,
  restoreArtifactReviewAccess,
  reviewDraftPrefix,
} from '../review-access-invalidation';

// Real page 2026-09-24: a stale review tab polled every 10 s; each identical denial re-broadcast a
// projection invalidation, and every mounted publication resolver re-read in response (5 reads a cycle).
const invalidations = vi.fn();
const revocations = vi.fn();
beforeEach(() => {
  localStorage.clear();
  window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidations);
  window.addEventListener(REVIEW_ACCESS_REVOKED, revocations);
});
afterEach(() => {
  window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidations);
  window.removeEventListener(REVIEW_ACCESS_REVOKED, revocations);
  restoreArtifactReviewAccess('review-a');
  restoreArtifactReviewAccess('review-b');
  invalidations.mockReset();
  revocations.mockReset();
});

// Sol review of #4643 @dc98a419: deduping the scoped event too silenced a reader that mounted later.
it('refreshes owner projections once per loss, but clears and tells readers on every denial', () => {
  invalidateArtifactReviewAccess('review-a');
  localStorage.setItem(`${reviewDraftPrefix('operator', 'review-a')}pending`, 'written later by another tab');
  invalidateArtifactReviewAccess('review-a');
  invalidateArtifactReviewAccess('review-a');

  expect(invalidations).toHaveBeenCalledTimes(1);
  expect(revocations).toHaveBeenCalledTimes(3);
  expect(localStorage.getItem(`${reviewDraftPrefix('operator', 'review-a')}pending`)).toBeNull();
});

it('clears only the denied review, whoever owned the draft, and leaves other storage alone', () => {
  const kept = [
    `${reviewDraftPrefix('operator', 'review-b')}pending`,
    `${reviewDraftPrefix('operator', 'review-ab')}round:1:annotation`,
    'workspace-content-review:ledger-1:round:1:markup',
  ];
  for (const key of [...kept, `${reviewDraftPrefix('someone', 'review-a')}round:1:markup`])
    localStorage.setItem(key, 'x');

  invalidateArtifactReviewAccess('review-a');

  expect(Object.keys(localStorage).sort()).toEqual([...kept].sort());
});

it('announces again after the review was readable in between, and keeps reviews apart', () => {
  invalidateArtifactReviewAccess('review-a');
  invalidateArtifactReviewAccess('review-b');
  restoreArtifactReviewAccess('review-a');
  invalidateArtifactReviewAccess('review-a');

  expect(invalidations).toHaveBeenCalledTimes(3);
  expect(revocations.mock.calls.map(([event]) => (event as CustomEvent).detail.reviewId)).toEqual([
    'review-a',
    'review-b',
    'review-a',
  ]);
});
