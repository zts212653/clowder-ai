/**
 * F140: Shared GitHub feedback filter — unified dedup across F140 API polling and email watcher.
 *
 * Rule A: self-authored feedback (comments + reviews) → skip everywhere.
 * Rule B: authoritative review bot feedback → skip in F140 (email channel is authoritative source).
 * Rule C: single predicate factory shared by both channels.
 *
 * @see docs/features/F140-github-pr-automation.md — Risk: "Review 双重消费"
 */

export interface GitHubFeedbackFilterOptions {
  /** Authenticated GitHub login (resolved at startup via `gh api /user`). undefined = filter disabled for self. */
  readonly selfGitHubLogin?: string;
  /** Logins whose feedback is handled by an authoritative channel (e.g. email watcher). F140 skips these. */
  readonly authoritativeReviewLogins: readonly string[];
}

export interface GitHubFeedbackFilter {
  /** Rule A only: is this author self-authored? Email watcher uses this (it IS the authoritative source, so Rule B doesn't apply). */
  isSelfAuthored: (author: string) => boolean;
  /** Rules A+B: should F140 API polling skip this comment? */
  shouldSkipComment: (comment: { author: string }) => boolean;
  /** Rules A+B: should F140 API polling skip this review decision? */
  shouldSkipReview: (review: { author: string }) => boolean;
}

/**
 * Create a feedback filter for F140 API polling channel.
 *
 * - Self-authored: always skip (cats posting via `gh` share the same GitHub account).
 * - Authoritative review bot: skip in F140 — email channel handles these as the single source of truth.
 */
export function createGitHubFeedbackFilter(opts: GitHubFeedbackFilterOptions): GitHubFeedbackFilter {
  const shouldSkip = (author: string): boolean => {
    if (opts.selfGitHubLogin != null && author === opts.selfGitHubLogin) return true;
    if (opts.authoritativeReviewLogins.includes(author)) return true;
    return false;
  };

  const isSelfAuthored = (author: string): boolean => opts.selfGitHubLogin != null && author === opts.selfGitHubLogin;

  return {
    isSelfAuthored,
    shouldSkipComment: (c) => shouldSkip(c.author),
    shouldSkipReview: (r) => shouldSkip(r.author),
  };
}
