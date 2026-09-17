export const REVIEW_ACCESS_REVOKED = 'cat-cafe:artifact-review-access-revoked';

/** A definite authenticated denial clears local review state; only the owner read retires attention. */
export function invalidateArtifactReviewAccess(reviewId: string): void {
  window.dispatchEvent(new CustomEvent(REVIEW_ACCESS_REVOKED, { detail: { reviewId } }));
  window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
}
