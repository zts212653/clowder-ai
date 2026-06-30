import { fetchPaginated } from './fetch-paginated.js';

export interface GithubItemWithId {
  id?: unknown;
}

export interface FetchLatestIssueCommentCursorOptions {
  ghToken?: string;
  fetcher?: (endpoint: string, options: { ghToken?: string }) => Promise<readonly GithubItemWithId[]>;
}

export function maxGithubId(items: readonly GithubItemWithId[]): number {
  let cursor = 0;
  for (const item of items) {
    if (typeof item.id === 'number' && Number.isFinite(item.id) && item.id > cursor) {
      cursor = item.id;
    }
  }
  return cursor;
}

export async function fetchLatestIssueCommentCursor(
  repoFullName: string,
  issueNumber: number,
  opts: FetchLatestIssueCommentCursorOptions = {},
): Promise<number> {
  const fetcher = opts.fetcher ?? fetchPaginated;
  const comments = await fetcher(`/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    ghToken: opts.ghToken,
  });
  return maxGithubId(comments);
}
