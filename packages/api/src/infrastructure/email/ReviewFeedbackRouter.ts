import type { GitHubReviewThreadBaseline } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  GitHubWaitLifecycleResult,
  GitHubWaitLifecycleService,
} from '../../domains/github-signals/GitHubWaitLifecycleService.js';
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
  readonly reviewThreads?: readonly GitHubReviewThreadBaseline[];
  readonly resultTriggerCommentId?: number;
  readonly resultSourceRef?: string;
  readonly resultConversationCommentCursor?: number;
  readonly resultDecision?: string;
  readonly resultReviewer?: string;
  readonly subjectState?: 'merged' | 'closed';
  readonly reviewLoopBrake?: GitHubReviewLoopBrake;
}

export type ReviewFeedbackRouteResult = (
  | {
      readonly kind: 'notified';
      readonly threadId: string;
      readonly catId: string;
      readonly messageId: string;
      readonly content: string;
    }
  | { readonly kind: 'skipped'; readonly reason: string }
) & {
  /**
   * `false`: the wait lifecycle recorded nothing of this observation — every write lost its race — so
   * the collector must not move its cursor past it.
   */
  readonly recorded?: false;
};

export interface ReviewFeedbackRouterOptions {
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly waitLifecycle: GitHubWaitLifecycleService;
  readonly log: FastifyBaseLogger;
}

/** One wait outcome, projected for the collector: what to wake, and whether it may move its cursor. */
function routeResultOf(result: GitHubWaitLifecycleResult): ReviewFeedbackRouteResult {
  if (result.kind === 'unrecorded') return { kind: 'skipped', reason: result.reason, recorded: false };
  if (result.kind !== 'notified') return { kind: 'skipped', reason: result.reason };
  return {
    kind: 'notified',
    threadId: result.task.threadId,
    catId: result.task.ownerCatId ?? '',
    messageId: result.messageId,
    content: result.content,
  };
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
          // The collector keeps reviews of an older commit out of `newDecisions`.
          ...(latestDecision ? { headDecisionCursor: latestDecision.id } : {}),
          ...(resultDecision ? { decision: resultDecision } : {}),
          ...(resultReviewer ? { reviewer: resultReviewer } : {}),
          ...(signal.reviewThreads ? { threads: signal.reviewThreads } : {}),
          ...(signal.resultTriggerCommentId ? { resultTriggerCommentId: signal.resultTriggerCommentId } : {}),
          ...(signal.resultSourceRef ? { resultSourceRef: signal.resultSourceRef } : {}),
          ...(signal.resultConversationCommentCursor
            ? { resultConversationCommentCursor: signal.resultConversationCommentCursor }
            : {}),
          // #1392 AC-6: these were only ever used to advance cursors below, so no predicate could
          // see them — "data collected, no notification". They are facts now.
          ...(signal.newComments.length > 0
            ? {
                comments: signal.newComments.map((comment) => ({
                  id: comment.id,
                  author: comment.author,
                  commentType: comment.commentType,
                  // #1392 AC-7: a wake says who replied, never what they said, so it has to hand the
                  // owner a way to go read it. Same shape the issue surface already emits.
                  sourceRef: `github:pr-comment:${comment.id}`,
                  // #1392 AC-7: the accepted maintainer/reviewer default filters bots and pure summon
                  // commands, and both are decided at delivery. The body reaches the matcher and stops
                  // there — it is never copied into what the owner is sent.
                  ...(comment.actorType ? { actorType: comment.actorType } : {}),
                  ...(comment.body ? { body: comment.body } : {}),
                })),
              }
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
      ...(signal.reviewLoopBrake ? { reviewLoopBrake: signal.reviewLoopBrake } : {}),
    });
    return routeResultOf(result);
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
