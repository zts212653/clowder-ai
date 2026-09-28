import type { GitHubReviewVerdictState, GitHubReviewVerdicts } from '@cat-cafe/shared';

/**
 * #1392: a review decision can change without a new review. GitHub dismisses a verdict in place: the
 * review keeps its id, author and submitted_at, and its state becomes DISMISSED. An id cursor never
 * sees that, so a wait records which reviews hold a verdict and compares their states.
 */

const VERDICT_STATES: ReadonlySet<string> = new Set<GitHubReviewVerdictState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]);

function isVerdictState(state: unknown): state is GitHubReviewVerdictState {
  return typeof state === 'string' && VERDICT_STATES.has(state);
}

type MutableVerdicts = Record<string, GitHubReviewVerdicts[string]>;

/** Every review that holds or held a verdict. Comment-only and pending reviews carry none. */
export function reviewVerdictsOf(
  reviews: readonly { readonly id?: unknown; readonly state?: unknown; readonly author?: string }[],
): GitHubReviewVerdicts {
  const verdicts: MutableVerdicts = {};
  for (const review of reviews) {
    if (typeof review.id !== 'number' || !isVerdictState(review.state)) continue;
    verdicts[String(review.id)] = { state: review.state, ...(review.author ? { author: review.author } : {}) };
  }
  return verdicts;
}

/**
 * What a wait has seen, advanced by one observation. DISMISSED is final, so a late observation that
 * still shows a verdict live cannot bring it back and have its dismissal reported a second time.
 */
export function mergeReviewVerdicts(
  seen: GitHubReviewVerdicts | undefined,
  observed: GitHubReviewVerdicts | undefined,
): GitHubReviewVerdicts | undefined {
  if (!observed) return seen;
  const merged: MutableVerdicts = { ...seen };
  for (const [reviewId, verdict] of Object.entries(observed)) {
    if (merged[reviewId]?.state !== 'DISMISSED') merged[reviewId] = verdict;
  }
  return merged;
}

export interface DismissedVerdict {
  readonly reviewId: string;
  readonly previous: Exclude<GitHubReviewVerdictState, 'DISMISSED'>;
  readonly author?: string;
}

/** Verdicts the wait saw live that this observation shows dismissed. */
export function dismissedVerdicts(
  seen: GitHubReviewVerdicts | undefined,
  observed: GitHubReviewVerdicts | undefined,
): DismissedVerdict[] {
  if (!seen || !observed) return [];
  const dismissed: DismissedVerdict[] = [];
  for (const [reviewId, verdict] of Object.entries(seen)) {
    if (verdict.state === 'DISMISSED' || observed[reviewId]?.state !== 'DISMISSED') continue;
    dismissed.push({ reviewId, previous: verdict.state, ...(verdict.author ? { author: verdict.author } : {}) });
  }
  return dismissed;
}
