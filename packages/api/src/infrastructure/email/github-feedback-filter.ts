/**
 * F140: Shared GitHub feedback filter — unified dedup across F140 API polling and email watcher.
 *
 * Rule A: self-authored feedback (comments + reviews) → skip everywhere.
 * Rule B: authoritative review bot feedback → skip in F140 for reviews + inline comments
 *         (email channel is authoritative source). Conversation comments (issue comments)
 *         are exempt — the email watcher cannot parse them, so F140 is the only channel.
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
  /**
   * Rules A+B: should F140 API polling skip this comment?
   *
   * Rule B (authoritative bot) only applies to `inline` comments — those are tied to
   * review submissions that the email watcher handles. `conversation` comments (issue
   * comments posted to `/issues/N/comments`) are NOT handled by the email watcher's
   * review parser, so F140 is the only delivery channel for them.
   */
  shouldSkipComment: (comment: { author: string; commentType?: 'inline' | 'conversation' }) => boolean;
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
    shouldSkipComment: (c) => {
      // Rule A: self-authored → always skip
      if (isSelfAuthored(c.author)) return true;
      // Rule B: authoritative bot → skip only for inline comments (tied to review
      // submissions the email watcher handles). Conversation comments (issue comments)
      // are NOT handled by the email watcher, so F140 must deliver them.
      if (c.commentType === 'conversation') return false;
      return opts.authoritativeReviewLogins.includes(c.author);
    },
    shouldSkipReview: (r) => shouldSkip(r.author),
  };
}
