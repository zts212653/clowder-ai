import type { GitHubReviewThreadBaseline } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { GitHubWaitLifecycleService } from '../../domains/github-signals/GitHubWaitLifecycleService.js';
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
  readonly reviewThreads?: readonly GitHubReviewThreadBaseline[];
  readonly resultTriggerCommentId?: number;
  readonly resultSourceRef?: string;
  readonly resultConversationCommentCursor?: number;
  readonly resultDecision?: string;
  readonly resultReviewer?: string;
  readonly subjectState?: 'merged' | 'closed';
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
    const latestDecision = [...signal.newDecisions].sort((left, right) => left.id - right.id).at(-1);
    const resultDecision = signal.resultDecision ?? latestDecision?.state;
    const resultReviewer = signal.resultReviewer ?? latestDecision?.author;
    const result = await this.opts.waitLifecycle.observe({
      taskId: tracking.taskId,
      facts: {
        headSha: signal.headSha,
        review: {
          decisionCursor: signal.decisionCursor,
          ...(resultDecision ? { decision: resultDecision } : {}),
          ...(resultReviewer ? { reviewer: resultReviewer } : {}),
          ...(signal.reviewThreads ? { threads: signal.reviewThreads } : {}),
          ...(signal.resultTriggerCommentId ? { resultTriggerCommentId: signal.resultTriggerCommentId } : {}),
          ...(signal.resultSourceRef ? { resultSourceRef: signal.resultSourceRef } : {}),
          ...(signal.resultConversationCommentCursor
            ? { resultConversationCommentCursor: signal.resultConversationCommentCursor }
            : {}),
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

/**
 * Compatibility export for callers that still need a deterministic preview.
 * Source bodies and caller prose are intentionally not part of the renderer.
 */
export function buildReviewFeedbackContent(signal: {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly newComments: readonly PrFeedbackComment[];
  readonly newDecisions: readonly PrReviewDecision[];
}): string {
  const latestDecision = [...signal.newDecisions].sort((left, right) => left.id - right.id).at(-1);
  const deltas = latestDecision
    ? [`- review result: ${latestDecision.state} (${latestDecision.author})`]
    : [
        `- review source frontier advanced (${signal.newComments.length} item${signal.newComments.length === 1 ? '' : 's'})`,
      ];
  return [
    `🔔 **PR wait candidate** — ${signal.repoFullName}#${signal.prNumber}`,
    '',
    ...deltas,
    '',
    'The typed wait predicate decides whether this becomes an owner wake.',
  ].join('\n');
}
