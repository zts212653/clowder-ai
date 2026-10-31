export const REVIEW_ACCESS_REVOKED = 'cat-cafe:artifact-review-access-revoked';

const REVIEW_STORAGE = 'cat-cafe:review:';

/** Where a review keeps its drafts, markup and pending retry in this browser. */
export function reviewDraftPrefix(userId: string, reviewId: string): string {
  return `${REVIEW_STORAGE}${userId}:${reviewId}:`;
}

/** Reviews whose loss the owner projections already heard about. */
const announced = new Set<string>();

/**
 * A definite authenticated denial clears local review state; only the owner read retires attention.
 * Every denial clears what this browser kept for the review and tells mounted readers, whoever saw it
 * first and whoever mounts later. Only the owner-projection refresh is announced once: a stale tab
 * keeps re-reading (access may return), and each identical denial made every mounted publication
 * resolver re-read in a loop.
 */
export function invalidateArtifactReviewAccess(reviewId: string): void {
  forgetLocalReview(reviewId);
  window.dispatchEvent(new CustomEvent(REVIEW_ACCESS_REVOKED, { detail: { reviewId } }));
  if (announced.has(reviewId)) return;
  announced.add(reviewId);
  window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
}

/** A successful read of the review makes a later loss news again. */
export function restoreArtifactReviewAccess(reviewId: string): void {
  announced.delete(reviewId);
}

/** The denied reader may never have loaded the review, so its owner is unknown: match the review id. */
function forgetLocalReview(reviewId: string): void {
  const segment = `:${reviewId}:`;
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(REVIEW_STORAGE) && key.slice(REVIEW_STORAGE.length).includes(segment))
        localStorage.removeItem(key);
  } catch {
    /* Browser storage may be blocked; fresh authority still fences every future mount. */
  }
}
