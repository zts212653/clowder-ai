/**
 * F140/F320: ReviewFeedbackTaskSpec — detect new PR review feedback (comments + decisions).
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 * KD-11: Replaces ReviewCommentsTaskSpec with richer model.
 * KD-10: Cursor commits only after delivery success; trigger is best-effort.
 *
 * Gate: list pr_tracking tasks → fetch comments + reviews → filter by cursor → workItems.
 * Execute: ReviewFeedbackRouter → ConnectorInvokeTrigger → commitCursor.
 */
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { PrFeedbackComment, PrReviewDecision, ReviewFeedbackRouter } from './ReviewFeedbackRouter.js';

export interface ReviewFeedbackSignal {
  task: TaskItem;
  repoFullName: string;
  prNumber: number;
  newComments: PrFeedbackComment[];
  newDecisions: PrReviewDecision[];
  commitCursor: () => Promise<void>;
}

export interface ReviewFeedbackTaskSpecOptions {
  readonly taskStore: ITaskStore;
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
  readonly isEchoComment?: (comment: PrFeedbackComment) => boolean;
  readonly isEchoReview?: (review: PrReviewDecision) => boolean;
}

export function createReviewFeedbackTaskSpec(opts: ReviewFeedbackTaskSpecOptions): TaskSpec_P1<ReviewFeedbackSignal> {
  // In-memory cursors: highest seen comment ID and review ID per PR
  const commentCursors = new Map<string, number>();
  const reviewCursors = new Map<string, number>();

  /**
   * Advance cursor: persist to store + update in-memory map.
   *
   * Two policies (matching blast radius of each failure mode):
   * - persistFirst (echo-skip): no delivery happened → persist first, skip memory on failure → safe retry
   * - memoryFirst  (post-delivery): notification sent → advance memory first → prevent duplicate spam
   */
  async function advanceCursor(
    taskId: string,
    prKey: string,
    cursors: { comment: number; decision: number },
    policy: 'persistFirst' | 'memoryFirst',
  ): Promise<void> {
    const patch = {
      review: {
        lastCommentCursor: cursors.comment,
        lastDecisionCursor: cursors.decision,
        ...(policy === 'memoryFirst' ? { lastNotifiedAt: Date.now() } : {}),
      },
    };
    const setMemory = () => {
      commentCursors.set(prKey, cursors.comment);
      reviewCursors.set(prKey, cursors.decision);
    };

    if (policy === 'memoryFirst') {
      setMemory();
      try {
        await opts.taskStore.patchAutomationState(taskId, patch);
      } catch (e) {
        opts.log.warn(`[review-feedback] cursor persist failed for ${prKey}, restart may replay`, e);
      }
    } else {
      try {
        await opts.taskStore.patchAutomationState(taskId, patch);
        setMemory();
      } catch (e) {
        opts.log.warn(`[review-feedback] echo-skip persist failed for ${prKey}, will retry next tick`, e);
      }
    }
  }

  return {
    id: 'review-feedback',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        // #320: Read from unified TaskStore — exclude done tasks (PR merged/closed)
        const tasks = (await opts.taskStore.listByKind('pr_tracking')).filter((t) => t.status !== 'done');
        if (tasks.length === 0) {
          return { run: false, reason: 'no tracked PRs' };
        }

        const workItems: { signal: ReviewFeedbackSignal; subjectKey: string }[] = [];

        for (const task of tasks) {
          try {
            const parsed = task.subjectKey ? parsePrSubjectKey(task.subjectKey) : null;
            if (!parsed) continue;
            const { repoFullName, prNumber } = parsed;
            const prKey = `${repoFullName}#${prNumber}`;

            const [comments, reviews] = await Promise.all([
              opts.fetchComments(repoFullName, prNumber),
              opts.fetchReviews(repoFullName, prNumber),
            ]);

            // #406: Seed from persisted automationState.review on first access (survives restart)
            const commentCursor = commentCursors.get(prKey) ?? task.automationState?.review?.lastCommentCursor ?? 0;
            const reviewCursor = reviewCursors.get(prKey) ?? task.automationState?.review?.lastDecisionCursor ?? 0;

            const allNewComments = comments.filter((c) => c.id > commentCursor);
            const allNewReviews = reviews.filter((r) => r.id > reviewCursor);

            const commentFilter = opts.isEchoComment;
            const reviewFilter = opts.isEchoReview;
            const newComments = commentFilter ? allNewComments.filter((c) => !commentFilter(c)) : allNewComments;
            const newDecisions = reviewFilter ? allNewReviews.filter((r) => !reviewFilter(r)) : allNewReviews;

            const maxCommentId =
              allNewComments.length > 0 ? Math.max(...allNewComments.map((c) => c.id)) : commentCursor;
            const maxReviewId = allNewReviews.length > 0 ? Math.max(...allNewReviews.map((r) => r.id)) : reviewCursor;

            const allSkipped = newComments.length === 0 && newDecisions.length === 0;
            const hadNewItems = allNewComments.length > 0 || allNewReviews.length > 0;
            if (hadNewItems && allSkipped) {
              await advanceCursor(task.id, prKey, { comment: maxCommentId, decision: maxReviewId }, 'persistFirst');
              continue;
            }

            if (newComments.length === 0 && newDecisions.length === 0) continue;

            workItems.push({
              signal: {
                task,
                repoFullName,
                prNumber,
                newComments,
                newDecisions,
                commitCursor: () =>
                  advanceCursor(task.id, prKey, { comment: maxCommentId, decision: maxReviewId }, 'memoryFirst'),
              },
              // #320 KD-15: unified subject_key format
              subjectKey: task.subjectKey!,
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
        const { task } = signal;
        const routeResult = await opts.reviewFeedbackRouter.route(
          {
            repoFullName: signal.repoFullName,
            prNumber: signal.prNumber,
            newComments: signal.newComments,
            newDecisions: signal.newDecisions,
          },
          {
            threadId: task.threadId,
            catId: task.ownerCatId ?? '',
            userId: task.userId ?? '',
          },
        );

        if (routeResult.kind !== 'notified') return;

        await signal.commitCursor();

        if (opts.invokeTrigger) {
          try {
            const hasChangesRequested = signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED');
            const hasApproved = !hasChangesRequested && signal.newDecisions.some((d) => d.state === 'APPROVED');
            const suggestedSkill = hasChangesRequested ? 'receive-review' : hasApproved ? 'merge-gate' : undefined;

            const policy: ConnectorTriggerPolicy = {
              priority: hasChangesRequested ? 'urgent' : 'normal',
              reason: 'github_review_feedback',
              suggestedSkill,
            };
            opts.invokeTrigger.trigger(
              routeResult.threadId,
              routeResult.catId as CatId,
              task.userId ?? '',
              routeResult.content,
              routeResult.messageId,
              undefined,
              policy,
            );
          } catch {
            opts.log.warn(
              `[review-feedback] trigger failed for ${signal.repoFullName}#${signal.prNumber} (best-effort)`,
            );
          }
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: 'Review 反馈',
      category: 'pr',
      description: '聚合 PR review comments 通知猫猫',
      subjectKind: 'pr',
    },
  };
}
