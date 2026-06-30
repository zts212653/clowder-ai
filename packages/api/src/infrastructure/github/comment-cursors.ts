/**
 * #1053: Cursor seeding returns 0 — new registrations have processed nothing yet.
 * The old maxGithubId() approach seeded at the latest comment ID, causing the first
 * poll to miss all existing comments.
 */

export interface FetchLatestIssueCommentCursorOptions {
  ghToken?: string;
}

/**
 * Return the initial comment cursor for a newly registered issue.
 * Always 0 — nothing has been processed yet (#1053).
 */
export async function fetchLatestIssueCommentCursor(
  _repoFullName: string,
  _issueNumber: number,
  _opts: FetchLatestIssueCommentCursorOptions = {},
): Promise<number> {
  return 0;
}
