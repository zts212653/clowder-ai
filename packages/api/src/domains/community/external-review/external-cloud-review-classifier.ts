import type { AwaitStateV1 } from '@cat-cafe/shared';
import type { PrFeedbackComment, PrReviewDecision } from '../../../infrastructure/email/ReviewFeedbackRouter.js';
import type { ExternalCloudObservation } from './ExternalReviewCoordinator.js';

export interface ExternalCloudReviewClassifierInput {
  readonly currentHeadSha: string;
  readonly awaitState?: AwaitStateV1;
  readonly comments: readonly PrFeedbackComment[];
  readonly reviews: readonly PrReviewDecision[];
  readonly knownCloudReviewerLogins: readonly string[];
  readonly now: number;
  readonly timeoutMs: number;
}

export interface ExternalCloudReviewClassification {
  readonly observation: Omit<ExternalCloudObservation, 'repoFullName' | 'prNumber'> | null;
  readonly correlatedCommentIds: readonly number[];
  readonly correlatedReviewIds: readonly number[];
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function emptyClassification(): ExternalCloudReviewClassification {
  return { observation: null, correlatedCommentIds: [], correlatedReviewIds: [] };
}

export function classifyExternalCloudReview(
  input: ExternalCloudReviewClassifierInput,
): ExternalCloudReviewClassification {
  const { awaitState } = input;
  const reviewResultPredicate = awaitState?.continuation.when.find(
    (predicate) => predicate.kind === 'pr_review_result_available',
  );
  const triggerCommentId =
    reviewResultPredicate?.kind === 'pr_review_result_available'
      ? (reviewResultPredicate.triggerCommentId ?? awaitState?.baseline.review?.resultTriggerCommentId)
      : undefined;
  if (
    !awaitState ||
    !reviewResultPredicate ||
    !triggerCommentId ||
    awaitState.baseline.review?.resultTriggerHeadSha !== input.currentHeadSha
  ) {
    return emptyClassification();
  }

  const knownLogins = new Set(input.knownCloudReviewerLogins.map(normalizeLogin));
  const isKnownCloudReviewer = (login: string) => knownLogins.has(normalizeLogin(login));
  const currentHeadReviews = input.reviews
    .filter((review) => review.commitId === input.currentHeadSha && isKnownCloudReviewer(review.author))
    .sort((left, right) => right.id - left.id);
  const decision = currentHeadReviews[0];

  if (decision) {
    const findings = input.comments.filter(
      (comment) =>
        comment.commentType === 'inline' &&
        comment.commitId === input.currentHeadSha &&
        comment.reviewId === decision.id &&
        isKnownCloudReviewer(comment.author),
    );
    const status =
      decision.state === 'DISMISSED'
        ? 'failed_or_timeout'
        : decision.state === 'CHANGES_REQUESTED' || findings.length > 0
          ? 'blocking'
          : 'clean';
    return {
      observation: {
        headSha: input.currentHeadSha,
        status,
        triggerCommentId,
        reviewId: decision.id,
      },
      correlatedCommentIds: findings.map((comment) => comment.id),
      correlatedReviewIds: [decision.id],
    };
  }

  const timedOut = input.now - awaitState.createdAt >= input.timeoutMs;
  return {
    observation: {
      headSha: input.currentHeadSha,
      status: timedOut ? 'failed_or_timeout' : 'running',
      triggerCommentId,
    },
    correlatedCommentIds: [],
    correlatedReviewIds: [],
  };
}
