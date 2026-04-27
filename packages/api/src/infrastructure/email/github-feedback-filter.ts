/**
 * F140: GitHub feedback filter — Rule A (self-authored) only post-E.2 cutover.
 *
 * E.2 history (2026-04-24): Rule B (authoritative-source skip) was DROPPED.
 * After cutover, polling (`ReviewFeedbackTaskSpec`) is the sole truth source
 * for review feedback. Skipping authoritative bots in polling = data loss.
 *
 * Setup-noise (bot Codex setup guidance conversation comments) is handled
 * separately by `setup-noise-filter.ts` in the polling gate, scoped narrowly
 * to bot + conversation + setup-only bodies (see F140 spec AC-E6).
 *
 * Rule C (single predicate factory shared with email watcher) is also retired
 * because email watcher bootstrap was removed in E.2 (and the source files
 * physically deleted in E.3).
 *
 * @see docs/features/F140-github-pr-automation.md — Phase E.2 + KD-15
 */

export interface GitHubFeedbackFilterOptions {
  /** Authenticated GitHub login (resolved at startup via `gh api /user`). undefined = filter disabled for self. */
  readonly selfGitHubLogin?: string;
}

export interface GitHubFeedbackFilter {
  /** Rule A: is this author self-authored? */
  isSelfAuthored: (author: string) => boolean;
  /** Rule A: should polling skip this comment (self-authored only)? */
  shouldSkipComment: (comment: { author: string; commentType?: 'inline' | 'conversation' }) => boolean;
  /** Rule A: should polling skip this review decision (self-authored only)? */
  shouldSkipReview: (review: { author: string }) => boolean;
}

export function createGitHubFeedbackFilter(opts: GitHubFeedbackFilterOptions): GitHubFeedbackFilter {
  const isSelfAuthored = (author: string): boolean => opts.selfGitHubLogin != null && author === opts.selfGitHubLogin;

  return {
    isSelfAuthored,
    shouldSkipComment: (c) => isSelfAuthored(c.author),
    shouldSkipReview: (r) => isSelfAuthored(r.author),
  };
}
