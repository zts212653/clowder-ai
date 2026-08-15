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
  readonly waitResult?: ExternalCloudReviewWaitResult;
}

export interface ExternalCloudReviewWaitResult {
  readonly triggerCommentId: number;
  readonly sourceRef: `review:${number}` | `conversation:${number}`;
  readonly decisionCursor?: number;
  readonly conversationCommentCursor?: number;
  readonly reviewer: string;
  readonly decision: string;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function emptyClassification(): ExternalCloudReviewClassification {
  return { observation: null, correlatedCommentIds: [], correlatedReviewIds: [] };
}

function reviewedCommitFromCanonicalCleanComment(body: string): string | null {
  const firstLine = body.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^Codex Review:\s*Didn't find any major issues\.(?:[^\r\n]*)$/i.test(firstLine)) return null;
  const matches = [...body.matchAll(/^\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`\s*$/gim)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function findCanonicalCleanConversation(input: {
  readonly comments: readonly PrFeedbackComment[];
  readonly currentHeadSha: string;
  readonly triggerCommentId: number;
  readonly conversationBaseline: number;
  readonly isKnownCloudReviewer: (login: string) => boolean;
}): PrFeedbackComment | undefined {
  return [...input.comments]
    .filter(
      (comment) =>
        comment.commentType === 'conversation' &&
        comment.id > input.triggerCommentId &&
        comment.id > input.conversationBaseline &&
        input.isKnownCloudReviewer(comment.author),
    )
    .sort((left, right) => right.id - left.id)
    .find((comment) => {
      const reviewedCommit = reviewedCommitFromCanonicalCleanComment(comment.body);
      return reviewedCommit !== null && input.currentHeadSha.toLowerCase().startsWith(reviewedCommit.toLowerCase());
    });
}

function classifyCurrentHeadReview(input: {
  readonly comments: readonly PrFeedbackComment[];
  readonly reviews: readonly PrReviewDecision[];
  readonly currentHeadSha: string;
  readonly triggerCommentId: number;
  readonly isKnownCloudReviewer: (login: string) => boolean;
}): ExternalCloudReviewClassification | null {
  const decision = [...input.reviews]
    .filter((review) => review.commitId === input.currentHeadSha && input.isKnownCloudReviewer(review.author))
    .sort((left, right) => right.id - left.id)[0];
  if (!decision) return null;
  const findings = input.comments.filter(
    (comment) =>
      comment.commentType === 'inline' &&
      comment.commitId === input.currentHeadSha &&
      comment.reviewId === decision.id &&
      input.isKnownCloudReviewer(comment.author),
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
      triggerCommentId: input.triggerCommentId,
      reviewId: decision.id,
    },
    correlatedCommentIds: findings.map((comment) => comment.id),
    correlatedReviewIds: [decision.id],
    waitResult: {
      triggerCommentId: input.triggerCommentId,
      sourceRef: `review:${decision.id}`,
      decisionCursor: decision.id,
      reviewer: decision.author,
      decision: decision.state,
    },
  };
}

export function classifyExternalCloudReview(
  input: ExternalCloudReviewClassifierInput,
): ExternalCloudReviewClassification {
  const { awaitState } = input;
  if (!awaitState || !('headSha' in awaitState.baseline)) return emptyClassification();
  const baseline = awaitState.baseline;
  const reviewResultPredicate = awaitState?.continuation.when.find(
    (predicate) => predicate.kind === 'pr_review_result_available',
  );
  const triggerCommentId =
    reviewResultPredicate?.kind === 'pr_review_result_available'
      ? (reviewResultPredicate.triggerCommentId ?? baseline.review?.resultTriggerCommentId)
      : undefined;
  if (!reviewResultPredicate || !triggerCommentId || baseline.review?.resultTriggerHeadSha !== input.currentHeadSha) {
    return emptyClassification();
  }

  const knownLogins = new Set(input.knownCloudReviewerLogins.map(normalizeLogin));
  const isKnownCloudReviewer = (login: string) => knownLogins.has(normalizeLogin(login));
  const reviewClassification = classifyCurrentHeadReview({
    comments: input.comments,
    reviews: input.reviews,
    currentHeadSha: input.currentHeadSha,
    triggerCommentId,
    isKnownCloudReviewer,
  });
  if (reviewClassification) return reviewClassification;

  const conversationBaseline = baseline.review?.conversationCommentCursor ?? triggerCommentId;
  const cleanConversation = findCanonicalCleanConversation({
    comments: input.comments,
    currentHeadSha: input.currentHeadSha,
    triggerCommentId,
    conversationBaseline,
    isKnownCloudReviewer,
  });
  if (cleanConversation) {
    return {
      observation: {
        headSha: input.currentHeadSha,
        status: 'clean',
        triggerCommentId,
      },
      correlatedCommentIds: [cleanConversation.id],
      correlatedReviewIds: [],
      waitResult: {
        triggerCommentId,
        sourceRef: `conversation:${cleanConversation.id}`,
        conversationCommentCursor: cleanConversation.id,
        reviewer: cleanConversation.author,
        decision: 'CLEAN',
      },
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
