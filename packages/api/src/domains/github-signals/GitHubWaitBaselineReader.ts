import type {
  GitHubReviewThreadBaseline,
  GitHubWaitBaseline,
  GitHubWaitPredicate,
  PrAutomationState,
} from '@cat-cafe/shared';

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
  readonly fetchMergeState: (repoFullName: string, prNumber: number) => Promise<string>;
  readonly fetchReviewThreads: (
    repoFullName: string,
    prNumber: number,
    reviewThreadIds: readonly string[],
  ) => Promise<readonly GitHubReviewThreadBaseline[]>;
  readonly now?: () => number;
}

export interface InitialPrWaitSnapshot {
  readonly baseline: GitHubWaitBaseline;
  readonly collectorState: PrAutomationState;
}

function maxGithubId(items: readonly GithubIdItem[]): number {
  let max = 0;
  for (const item of items) {
    if (typeof item.id === 'number' && Number.isFinite(item.id)) max = Math.max(max, item.id);
  }
  return max;
}

function hasPredicate(when: readonly GitHubWaitPredicate[], ...kinds: GitHubWaitPredicate['kind'][]): boolean {
  return when.some((predicate) => kinds.includes(predicate.kind));
}

export async function readGitHubWaitBaseline(
  input: {
    readonly repoFullName: string;
    readonly prNumber: number;
    readonly when: readonly GitHubWaitPredicate[];
  },
  deps: GitHubWaitBaselineReaderDeps,
): Promise<InitialPrWaitSnapshot> {
  const ci = await deps.fetchCi(input.repoFullName, input.prNumber);
  if (!ci?.headSha) {
    throw new Error(`Current PR HEAD unavailable for ${input.repoFullName}#${input.prNumber}`);
  }

  const needsReview = hasPredicate(
    input.when,
    'pr_review_result_available',
    'pr_review_decision_changed',
    'pr_review_thread_changed',
  );
  const needsCi = hasPredicate(input.when, 'pr_ci_terminal');
  const needsConflict = hasPredicate(input.when, 'pr_became_conflicting');
  const reviewThreadIds = input.when.flatMap((predicate) =>
    predicate.kind === 'pr_review_thread_changed' ? predicate.reviewThreadIds : [],
  );

  const [inlineComments, conversationComments, reviews, mergeState, threads] = await Promise.all([
    needsReview ? deps.fetchInlineComments(input.repoFullName, input.prNumber) : [],
    needsReview ? deps.fetchConversationComments(input.repoFullName, input.prNumber) : [],
    needsReview ? deps.fetchReviews(input.repoFullName, input.prNumber) : [],
    needsConflict ? deps.fetchMergeState(input.repoFullName, input.prNumber) : undefined,
    reviewThreadIds.length > 0
      ? deps.fetchReviewThreads(input.repoFullName, input.prNumber, reviewThreadIds)
      : Promise.resolve([]),
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
  const resultTriggerCommentId = input.when.find(
    (predicate): predicate is Extract<GitHubWaitPredicate, { kind: 'pr_review_result_available' }> =>
      predicate.kind === 'pr_review_result_available' && predicate.triggerCommentId !== undefined,
  )?.triggerCommentId;

  const reviewState = needsReview
    ? {
        inlineCommentCursor,
        conversationCommentCursor,
        decisionCursor,
        ...(latestReview?.state ? { decision: latestReview.state } : {}),
        ...(resultTriggerCommentId !== undefined ? { resultTriggerCommentId, resultTriggerHeadSha: ci.headSha } : {}),
        ...(threads.length > 0 ? { threads } : {}),
      }
    : undefined;

  return {
    baseline: {
      capturedAt,
      headSha: ci.headSha,
      ...(reviewState ? { review: reviewState } : {}),
      ...(needsCi
        ? {
            ci: {
              bucket: ciBucket,
              fingerprint: `${ci.headSha}:${ciBucket}`,
            },
          }
        : {}),
      ...(mergeState !== undefined ? { conflict: { mergeState } } : {}),
    },
    collectorState: {
      ...(needsReview
        ? {
            review: {
              lastCommentCursor: Math.max(inlineCommentCursor, conversationCommentCursor),
              lastInlineCommentCursor: inlineCommentCursor,
              lastConversationCommentCursor: conversationCommentCursor,
              lastDecisionCursor: decisionCursor,
            },
          }
        : {}),
      ci: {
        headSha: ci.headSha,
        lastFingerprint: `${ci.headSha}:${ciBucket}`,
        lastBucket: ciBucket,
      },
      ...(mergeState !== undefined ? { conflict: { mergeState } } : {}),
    },
  };
}
