/**
 * F140: ReviewFeedbackTaskSpec — detect new PR review feedback (comments + decisions).
 *
 * KD-11: Replaces ReviewCommentsTaskSpec with richer model.
 * KD-10: Cursor commits only after delivery success; trigger is best-effort.
 *
 * Gate: list tracked PRs → fetch comments + reviews → filter by cursor → workItems.
 * Execute: ReviewFeedbackRouter → ConnectorInvokeTrigger → commitCursor.
 */
import type { CatId } from '@cat-cafe/shared';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IPrTrackingStore, PrTrackingEntry } from './PrTrackingStore.js';
import type { PrFeedbackComment, PrReviewDecision, ReviewFeedbackRouter } from './ReviewFeedbackRouter.js';

export interface ReviewFeedbackSignal {
  entry: PrTrackingEntry;
  newComments: PrFeedbackComment[];
  newDecisions: PrReviewDecision[];
  commitCursor: () => void;
}

export interface ReviewFeedbackTaskSpecOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly fetchComments: (repoFullName: string, prNumber: number) => Promise<PrFeedbackComment[]>;
  readonly fetchReviews: (repoFullName: string, prNumber: number) => Promise<PrReviewDecision[]>;
  readonly reviewFeedbackRouter: ReviewFeedbackRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  /** Predicate to identify comments that should be skipped (self-authored, authoritative bot, etc.). Matched comments are silently skipped and their cursor advanced. */
  readonly isEchoComment?: (comment: PrFeedbackComment) => boolean;
  /** Predicate to identify review decisions that should be skipped (self-authored, authoritative bot, etc.). Matched reviews are silently skipped and their cursor advanced. */
  readonly isEchoReview?: (review: PrReviewDecision) => boolean;
}

export function createReviewFeedbackTaskSpec(opts: ReviewFeedbackTaskSpecOptions): TaskSpec_P1<ReviewFeedbackSignal> {
  // In-memory cursors: highest seen comment ID and review ID per PR
  const commentCursors = new Map<string, number>();
  const reviewCursors = new Map<string, number>();

  return {
    id: 'review-feedback',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        const entries = await opts.prTrackingStore.listAll();
        if (entries.length === 0) {
          return { run: false, reason: 'no tracked PRs' };
        }

        const workItems: { signal: ReviewFeedbackSignal; subjectKey: string }[] = [];

        for (const entry of entries) {
          try {
            const prKey = `${entry.repoFullName}#${entry.prNumber}`;

            const [comments, reviews] = await Promise.all([
              opts.fetchComments(entry.repoFullName, entry.prNumber),
              opts.fetchReviews(entry.repoFullName, entry.prNumber),
            ]);

            const commentCursor = commentCursors.get(prKey) ?? 0;
            const reviewCursor = reviewCursors.get(prKey) ?? 0;

            const allNewComments = comments.filter((c) => c.id > commentCursor);
            const allNewReviews = reviews.filter((r) => r.id > reviewCursor);

            // Echo filter: skip comments/reviews that match the predicates (self-authored, authoritative bot, etc.).
            // Cursor still advances past them so they don't reappear next cycle.
            const commentFilter = opts.isEchoComment;
            const reviewFilter = opts.isEchoReview;
            const newComments = commentFilter ? allNewComments.filter((c) => !commentFilter(c)) : allNewComments;
            const newDecisions = reviewFilter ? allNewReviews.filter((r) => !reviewFilter(r)) : allNewReviews;

            // Cursor must cover ALL fetched items (including echoes) to avoid re-processing
            const maxCommentId =
              allNewComments.length > 0 ? Math.max(...allNewComments.map((c) => c.id)) : commentCursor;
            const maxReviewId = allNewReviews.length > 0 ? Math.max(...allNewReviews.map((r) => r.id)) : reviewCursor;

            // Advance cursor past echo-only batches so they don't reappear
            const allSkipped = newComments.length === 0 && newDecisions.length === 0;
            const hadNewItems = allNewComments.length > 0 || allNewReviews.length > 0;
            if (hadNewItems && allSkipped) {
              commentCursors.set(prKey, maxCommentId);
              reviewCursors.set(prKey, maxReviewId);
              continue;
            }

            if (newComments.length === 0 && newDecisions.length === 0) continue;

            workItems.push({
              signal: {
                entry,
                newComments,
                newDecisions,
                // KD-10: cursor advances only in execute, after delivery success
                commitCursor: () => {
                  commentCursors.set(prKey, maxCommentId);
                  reviewCursors.set(prKey, maxReviewId);
                },
              },
              subjectKey: `pr-${entry.repoFullName}#${entry.prNumber}`,
            });
          } catch {
            // fail-open: skip PRs where fetch fails
          }
        }

        if (workItems.length === 0) {
          return { run: false, reason: 'no new feedback' };
        }

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(signal: ReviewFeedbackSignal, _subjectKey: string, _ctx: ExecuteContext) {
        const routeResult = await opts.reviewFeedbackRouter.route(
          {
            repoFullName: signal.entry.repoFullName,
            prNumber: signal.entry.prNumber,
            newComments: signal.newComments,
            newDecisions: signal.newDecisions,
          },
          { threadId: signal.entry.threadId, catId: signal.entry.catId, userId: signal.entry.userId },
        );

        if (routeResult.kind !== 'notified') return;

        // KD-10: delivery succeeded → commit cursor immediately
        signal.commitCursor();

        // Trigger is best-effort (KD-10)
        if (opts.invokeTrigger) {
          try {
            const hasChangesRequested = signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED');
            const policy: ConnectorTriggerPolicy = {
              priority: hasChangesRequested ? 'urgent' : 'normal',
              reason: 'github_review_feedback',
            };
            opts.invokeTrigger.trigger(
              routeResult.threadId,
              routeResult.catId as CatId,
              signal.entry.userId,
              routeResult.content,
              routeResult.messageId,
              undefined,
              policy,
            );
          } catch {
            opts.log.warn(
              `[review-feedback] trigger failed for ${signal.entry.repoFullName}#${signal.entry.prNumber} (best-effort)`,
            );
          }
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
  };
}
