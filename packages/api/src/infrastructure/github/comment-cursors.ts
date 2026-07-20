import { fetchPaginated } from './fetch-paginated.js';

export interface GithubItemWithId {
  id?: unknown;
}

export interface FetchLatestIssueCommentCursorOptions {
  ghToken?: string;
  fetcher?: (endpoint: string, options: { ghToken?: string }) => Promise<readonly GithubItemWithId[]>;
}

export interface InitialPrCiStatus {
  readonly headSha: string;
  readonly aggregateBucket: string;
}

export interface FetchInitialPrTrackingBoundaryOptions {
  readonly fetchCiStatus: (repoFullName: string, prNumber: number) => Promise<InitialPrCiStatus | null>;
}

/**
 * Seed a newly registered PR tracker.
 *
 * Review cursors intentionally start at zero so feedback posted before registration
 * remains visible to the first poll. CI keeps its current boundary because existing
 * check state is registration context, not review feedback.
 */
export async function fetchInitialPrTrackingBoundary(
  repoFullName: string,
  prNumber: number,
  opts: FetchInitialPrTrackingBoundaryOptions,
) {
  const ciStatus = await opts.fetchCiStatus(repoFullName, prNumber);
  return {
    review: {
      lastCommentCursor: 0,
      lastInlineCommentCursor: 0,
      lastConversationCommentCursor: 0,
      lastDecisionCursor: 0,
    },
    ...(ciStatus
      ? {
          ci: {
            headSha: ciStatus.headSha,
            ...(ciStatus.aggregateBucket === 'pending'
              ? {}
              : {
                  lastFingerprint: `${ciStatus.headSha}:${ciStatus.aggregateBucket}`,
                  lastBucket: ciStatus.aggregateBucket,
                }),
          },
        }
      : {}),
  };
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
