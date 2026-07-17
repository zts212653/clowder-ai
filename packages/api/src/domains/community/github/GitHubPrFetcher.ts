export interface GhPrFull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  user: string;
  head_sha: string;
  draft: boolean;
  labels: string[];
  updated_at: string;
}

export interface GhPrReview {
  user: string;
  state: string;
  commit_id: string;
}

type PrState = 'open' | 'merged' | 'closed';
type PrReplyState = 'unreplied' | 'replied' | 'has-new-activity';

export function mapGitHubPr(
  pr: GhPrFull,
  reviews: GhPrReview[],
): { state: PrState; replyState: PrReplyState; lastReviewedSha: string | null } {
  const state: PrState = pr.state === 'closed' ? (pr.merged_at ? 'merged' : 'closed') : 'open';

  if (state !== 'open') {
    return { state, replyState: 'replied', lastReviewedSha: null };
  }

  const nonAuthorReviews = reviews.filter((r) => r.user !== pr.user);
  if (nonAuthorReviews.length === 0) {
    return { state, replyState: 'unreplied', lastReviewedSha: null };
  }

  const latestReview = nonAuthorReviews[nonAuthorReviews.length - 1];
  const lastReviewedSha = latestReview.commit_id;

  if (pr.head_sha !== lastReviewedSha) {
    return { state, replyState: 'has-new-activity', lastReviewedSha };
  }

  return { state, replyState: 'replied', lastReviewedSha };
}
