import type { FastifyBaseLogger } from 'fastify';
import {
  type GitHubTrackingEvent,
  normalizePrFeedbackBatch,
} from '../../domains/github-signals/GitHubTrackingEvent.js';
import type { GitHubWaitLifecycleService } from '../../domains/github-signals/GitHubWaitLifecycleService.js';
import type { GitHubReviewLoopBrake } from '../../domains/github-signals/github-wait-renderer.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';

export interface PrFeedbackComment {
  readonly id: number;
  readonly reviewId?: number;
  readonly author: string;
  readonly actorType?: string;
  readonly body: string;
  readonly createdAt: string;
  readonly commitId?: string;
  readonly commentType: 'inline' | 'conversation';
  readonly filePath?: string;
  readonly line?: number;
  readonly authorAssociation?: string;
}

export interface PrReviewDecision {
  readonly id: number;
  readonly author: string;
  readonly actorType?: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'COMMENTED';
  readonly body: string;
  readonly submittedAt: string;
  readonly commitId?: string;
  readonly authorAssociation?: string;
}

export interface ReviewFeedbackRoutingAudit {
  readonly kind: 'legacy-auto-rotated-repaired';
  readonly previousThreadId: string;
  readonly repairedThreadId: string;
}

export interface ReviewFeedbackSignal {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly routingAudit?: ReviewFeedbackRoutingAudit;
  readonly newComments: readonly PrFeedbackComment[];
  readonly newDecisions: readonly PrReviewDecision[];
  readonly inlineCommentCursor: number;
  readonly conversationCommentCursor: number;
  readonly decisionCursor: number;
  readonly subjectState?: 'merged' | 'closed';
  readonly reviewLoopBrake?: GitHubReviewLoopBrake;
  /**
   * F280 section 3.2: the identity verdict, from the SAME predicate the rest of the poller
   * uses. Self-authored items still arrive here — they advance frontiers and they open bot
   * turns (A28); the chain's identity row is what stops them waking their own author.
   */
  readonly isSelfComment?: (comment: PrFeedbackComment) => boolean;
  readonly isSelfReview?: (review: PrReviewDecision) => boolean;
}

export type ReviewFeedbackRouteResult =
  | {
      readonly kind: 'notified';
      readonly threadId: string;
      readonly catId: string;
      readonly messageId: string;
      readonly content: string;
    }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface ReviewFeedbackRouterOptions {
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly waitLifecycle: GitHubWaitLifecycleService;
  readonly log: FastifyBaseLogger;
}

export class ReviewFeedbackRouter {
  constructor(private readonly opts: ReviewFeedbackRouterOptions) {}

  async route(signal: ReviewFeedbackSignal, tracking: { taskId: string }): Promise<ReviewFeedbackRouteResult> {
    const externalDecisions = signal.newDecisions.filter((review) => !signal.isSelfReview?.(review));
    const latestDecision = [...externalDecisions].sort((left, right) => left.id - right.id).at(-1);
    // Legacy typed facts remain available to internal wait kinds. Public tracking uses
    // the normalized events below, where conversation and inline comments are peers.
    const conversationComments = signal.newComments
      .filter((comment) => comment.commentType === 'conversation')
      .map((comment) => ({
        id: comment.id,
        author: comment.author,
        sourceRef: `github:pr-conversation-comment:${comment.id}`,
      }));
    const inlineComments = signal.newComments
      .filter((c) => c.commentType === 'inline')
      .map((c) => ({
        id: c.id,
        author: c.author,
        createdAt: c.createdAt,
        sourceRef: `github:pr-inline-comment:${c.id}`,
      }));
    const events: GitHubTrackingEvent[] = normalizePrFeedbackBatch({
      headSha: signal.headSha,
      comments: signal.newComments,
      decisions: signal.newDecisions,
      ...(signal.isSelfComment ? { isSelfComment: signal.isSelfComment } : {}),
      ...(signal.isSelfReview ? { isSelfReview: signal.isSelfReview } : {}),
    });
    const result = await this.opts.waitLifecycle.observe({
      taskId: tracking.taskId,
      events,
      facts: {
        headSha: signal.headSha,
        review: {
          decisionCursor: signal.decisionCursor,
          ...(latestDecision?.state ? { decision: latestDecision.state } : {}),
          ...(latestDecision?.author ? { reviewer: latestDecision.author } : {}),
          ...(conversationComments.length > 0 ? { conversationComments } : {}),
          ...(inlineComments.length > 0 ? { inlineComments } : {}),
        },
      },
      collectorPatch: {
        review: {
          lastCommentCursor: Math.max(signal.inlineCommentCursor, signal.conversationCommentCursor),
          lastInlineCommentCursor: signal.inlineCommentCursor,
          lastConversationCommentCursor: signal.conversationCommentCursor,
          lastDecisionCursor: signal.decisionCursor,
          ...(signal.subjectState ? { prState: signal.subjectState } : {}),
        },
      },
      ...(signal.subjectState ? { subjectState: signal.subjectState } : {}),
      ...(signal.reviewLoopBrake ? { reviewLoopBrake: signal.reviewLoopBrake } : {}),
    });
    if (result.kind !== 'notified') return { kind: 'skipped', reason: result.reason };
    return {
      kind: 'notified',
      threadId: result.task.threadId,
      catId: result.task.ownerCatId ?? '',
      messageId: result.messageId,
      content: result.content,
    };
  }
}
