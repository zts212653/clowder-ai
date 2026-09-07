import type { GitHubPrWaitBaseline, PrAutomationState } from '@cat-cafe/shared';

interface GithubIdItem {
  readonly id?: unknown;
}

interface GithubReviewItem extends GithubIdItem {
  readonly state?: string;
}

export interface GitHubWaitBaselineReaderDeps {
  readonly fetchCi: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<{ headSha: string; aggregateBucket: string } | null>;
  readonly fetchInlineComments: (repoFullName: string, prNumber: number) => Promise<readonly GithubIdItem[]>;
  readonly fetchConversationComments: (repoFullName: string, prNumber: number) => Promise<readonly GithubIdItem[]>;
  readonly fetchReviews: (repoFullName: string, prNumber: number) => Promise<readonly GithubReviewItem[]>;
  readonly fetchMergeState: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<{ readonly mergeState: string; readonly mergeStateStatus: string }>;
  /** F280 section 2.4b: the PR's author login, used only to pick role defaults. */
  readonly fetchAuthorLogin?: (repoFullName: string, prNumber: number) => Promise<string | null>;
  readonly now?: () => number;
}

export interface InitialPrWaitSnapshot {
  readonly baseline: GitHubPrWaitBaseline;
  readonly collectorState: PrAutomationState;
  /** Absent when GitHub could not tell us; the caller then defaults toward notifying. */
  readonly authorLogin?: string;
}

function maxGithubId(items: readonly GithubIdItem[]): number {
  let max = 0;
  for (const item of items) {
    if (typeof item.id === 'number' && Number.isFinite(item.id)) max = Math.max(max, item.id);
  }
  return max;
}

/**
 * Registration freezes frontiers. It does not look for open bot rounds.
 *
 * It used to: it scanned conversation history for a summon that looked like ours, asked a
 * coverage verifier whether the bot had reacted, and stamped the round with the registering
 * `invocationId` so F177 could clean-stop on it the same turn. Every part of that was a
 * different way of being wrong. The scan reads HISTORY, so the stamp landed on a summon some
 * EARLIER turn wrote, and a brand-new invocation inherited an exit it never earned. The
 * verifier reads an `EYES` reaction, which is transient and can vanish between two polls. And
 * the whole branch was reachable only through the MCP registration path, so production
 * behaviour was decided by code the poll path never executes.
 *
 * Rounds now have exactly one origin — F280 section 4b — the normalized stream, after the
 * cursor, from the owner's own summon. A cat that summons a bot and stops in the same turn
 * waits one poll interval to learn the round is open. That is the entire cost.
 */
export async function readGitHubWaitBaseline(
  input: {
    readonly repoFullName: string;
    readonly prNumber: number;
  },
  deps: GitHubWaitBaselineReaderDeps,
): Promise<InitialPrWaitSnapshot> {
  const ci = await deps.fetchCi(input.repoFullName, input.prNumber);
  if (!ci?.headSha) {
    throw new Error(`Current PR HEAD unavailable for ${input.repoFullName}#${input.prNumber}`);
  }

  // Registration freezes every source frontier. Conditional seeding previously
  // replayed history and made valid surfaces unmatchable after subscription changes.
  const [inlineComments, conversationComments, reviews, merge, authorLogin] = await Promise.all([
    deps.fetchInlineComments(input.repoFullName, input.prNumber),
    deps.fetchConversationComments(input.repoFullName, input.prNumber),
    deps.fetchReviews(input.repoFullName, input.prNumber),
    deps.fetchMergeState(input.repoFullName, input.prNumber),
    deps.fetchAuthorLogin?.(input.repoFullName, input.prNumber).catch(() => null) ?? Promise.resolve(null),
  ]);

  const inlineCommentCursor = maxGithubId(inlineComments);
  const conversationCommentCursor = maxGithubId(conversationComments);
  const decisionCursor = maxGithubId(reviews);
  const latestReview = [...reviews]
    .filter((review): review is GithubReviewItem & { id: number } => typeof review.id === 'number')
    .sort((a, b) => a.id - b.id)
    .at(-1);
  const ciBucket =
    ci.aggregateBucket === 'pass' || ci.aggregateBucket === 'fail' || ci.aggregateBucket === 'pending'
      ? ci.aggregateBucket
      : 'external_infrastructure';
  const capturedAt = (deps.now ?? Date.now)();

  const reviewState = {
    inlineCommentCursor,
    conversationCommentCursor,
    decisionCursor,
    ...(latestReview?.state ? { decision: latestReview.state } : {}),
  };

  return {
    ...(authorLogin ? { authorLogin } : {}),
    baseline: {
      capturedAt,
      headSha: ci.headSha,
      ...(authorLogin ? { prAuthorLogin: authorLogin } : {}),
      review: reviewState,
      ci: {
        bucket: ciBucket,
        fingerprint: `${ci.headSha}:${ciBucket}`,
      },
      conflict: { mergeState: merge.mergeState },
      base: { isBehind: merge.mergeStateStatus === 'BEHIND' },
    },
    collectorState: {
      review: {
        lastCommentCursor: Math.max(inlineCommentCursor, conversationCommentCursor),
        lastInlineCommentCursor: inlineCommentCursor,
        lastConversationCommentCursor: conversationCommentCursor,
        lastDecisionCursor: decisionCursor,
      },
      ci: {
        headSha: ci.headSha,
        lastFingerprint: `${ci.headSha}:${ciBucket}`,
        lastBucket: ciBucket,
      },
      conflict: { mergeState: merge.mergeState, mergeStateStatus: merge.mergeStateStatus },
    },
  };
}
