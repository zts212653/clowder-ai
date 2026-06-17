/**
 * F140 + clowder-ai#320: ReviewFeedbackTaskSpec — detect new PR review feedback (comments + decisions).
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 * KD-11: Replaces ReviewCommentsTaskSpec with richer model.
 * KD-10: Cursor commits only after delivery success; trigger is best-effort.
 *
 * Gate: list pr_tracking tasks → fetch comments + reviews → filter by cursor → workItems.
 * Execute: ReviewFeedbackRouter → ConnectorInvokeTrigger → commitCursor.
 */
import type { CatId, CommunityEvent, TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import { decideDelivery } from '../../domains/community/community-delivery-policy.js';
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

export interface ReviewFeedbackPrMetadata {
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
}

export interface ReviewFeedbackTaskSpecOptions {
  readonly taskStore: ITaskStore;
  /** Return null when PR metadata is temporarily unavailable; gate will continue without head/state filtering. */
  readonly fetchPrMetadata?: (repoFullName: string, prNumber: number) => Promise<ReviewFeedbackPrMetadata | null>;
  /** @param sinceId — when provided, only fetch items with id > sinceId (enables per-page early termination). */
  readonly fetchComments: (repoFullName: string, prNumber: number, sinceId?: number) => Promise<PrFeedbackComment[]>;
  /** @param sinceId — when provided, only fetch items with id > sinceId (enables per-page early termination). */
  readonly fetchReviews: (repoFullName: string, prNumber: number, sinceId?: number) => Promise<PrReviewDecision[]>;
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
  /**
   * F140 Phase E.1: bot setup-only conversation noise filter.
   * Semantically independent from isEchoComment (self-authored echo).
   * Both predicates return `skip` — OR'd together in gate().
   */
  readonly isNoiseComment?: (comment: PrFeedbackComment) => boolean;
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  readonly id?: string;
  // F168 Phase A: community event log + projector (best-effort, optional)
  readonly eventLog?: ICommunityEventLog;
  readonly projector?: { apply(event: CommunityEvent): Promise<void> };
  /**
   * #949: Thread rotation — pre-dispatch health gate.
   * When provided, enables automatic thread rotation for MR review threads
   * that have processed too many reviews (context overflow prevention).
   */
  readonly threadStore?: Pick<IThreadStore, 'create' | 'get'>;
  /**
   * #949: Maximum number of completed reviews per thread before rotating.
   * Default: 3 (safe for Sonnet's smaller context window; Opus handles ~5
   * but 3 is the conservative floor).
   */
  readonly maxReviewsPerThread?: number;
}

function resolveCursor(memoryCursor: number | undefined, persistedCursor: number | undefined): number {
  return Math.max(memoryCursor ?? 0, persistedCursor ?? 0);
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
    id: opts.id ?? 'review-feedback',
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

            const prMetadata = opts.fetchPrMetadata ? await opts.fetchPrMetadata(repoFullName, prNumber) : null;
            if (prMetadata?.prState === 'merged' || prMetadata?.prState === 'closed') {
              await opts.taskStore.update(task.id, { status: 'done' });
              opts.log.info(`[review-feedback] PR ${prKey} ${prMetadata.prState} — task marked done`);

              // F168 Phase A: emit pr.merged / pr.closed event (best-effort)
              if (opts.eventLog && task.subjectKey) {
                const subjectKey = task.subjectKey; // already in format pr:owner/repo#N
                const eventKind: CommunityEvent['kind'] = prMetadata.prState === 'merged' ? 'pr.merged' : 'pr.closed';
                try {
                  const communityEvent: CommunityEvent = {
                    sourceEventId: `lifecycle:${subjectKey}:${prMetadata.prState}`,
                    subjectKey,
                    kind: eventKind,
                    classification: 'state-changing',
                    payload: { prState: prMetadata.prState, repoFullName, prNumber },
                    at: Date.now(),
                  };
                  const { appended } = await opts.eventLog.append(communityEvent);
                  if (appended && opts.projector) {
                    await opts.projector.apply(communityEvent);
                  }
                } catch {
                  opts.log.warn(`[review-feedback] community event emit failed for ${prKey}`);
                }
              }

              continue;
            }

            // #406: Seed from persisted automationState.review on first access (survives restart).
            // Cursor sources are monotonic: re-registration may reseed persisted state
            // while a long-lived poller still has an older in-memory value.
            const commentCursor = resolveCursor(
              commentCursors.get(prKey),
              task.automationState?.review?.lastCommentCursor,
            );
            const reviewCursor = resolveCursor(
              reviewCursors.get(prKey),
              task.automationState?.review?.lastDecisionCursor,
            );

            // #798: Pass cursor to fetch for per-page client-side filtering (eliminates maxBuffer crash)
            const [comments, reviews] = await Promise.all([
              opts.fetchComments(repoFullName, prNumber, commentCursor),
              opts.fetchReviews(repoFullName, prNumber, reviewCursor),
            ]);

            const allNewComments = comments.filter((c) => c.id > commentCursor);
            const allNewReviews = reviews.filter((r) => r.id > reviewCursor);
            const freshNewComments = allNewComments.filter((c) => !isStaleCommitFeedback(c, prMetadata?.headSha));
            const freshNewReviews = allNewReviews.filter((r) => !isStaleCommitFeedback(r, prMetadata?.headSha));

            // F168 Phase B (R3-P1, R4-P1-A/B, R5-P1/P2): append ALL fresh activity to event log
            // BEFORE delivery filter — polling fallback for AC #1 dual-path (webhook + polling).
            //
            // Safe cursor tracking (R4-P1-B): track max ID of successfully processed items.
            // Break on first append/projector failure so cursor stays before the failing item,
            // ensuring it is retried on the next poll (never permanently lost).
            //
            // Repair path (R5-P1, matches GitHubRepoWebhookHandler.ts:469): when appended=false
            // (prior round: append succeeded but projector threw), call projector.apply best-effort
            // so the projection is repaired. Event log is source of truth; projector is eventual
            // consistency — a failed repair is swallowed; the projection rebuilds from the log.
            //
            // Delivery truncation (R5-P2): delivery uses only items that completed event-log
            // processing (safeDeliveryXxx). Items after the break point are excluded from this
            // poll's delivery to prevent duplicate notifications on the next poll.
            //
            // sourceEventId alignment (R4-P1-A): reviews use `review:{repo}#{pr}:{id}` to match
            // the webhook handler (GitHubRepoWebhookHandler.ts:445). Comments use `prcomment:...`
            // (unique to polling — PR conversation/inline comments are skipped by the webhook).
            let maxSafeCommentCursor = commentCursor;
            let maxSafeReviewCursor = reviewCursor;
            // Default: all fresh items are eligible for delivery (no eventLog configured).
            let safeDeliveryComments: typeof freshNewComments = freshNewComments;
            let safeDeliveryReviews: typeof freshNewReviews = freshNewReviews;
            if (opts.eventLog && task.subjectKey) {
              const subjectKey = task.subjectKey;
              const processedComments: typeof freshNewComments = [];
              const processedReviews: typeof freshNewReviews = [];
              // Cloud R18 P1: track the id of the first fresh item that fails (break boundary).
              // The stale-cursor advancement loops must NOT advance past this boundary — otherwise
              // a stale item with a higher id would advance the cursor past the failed fresh item,
              // silently dropping it from the retry queue (it would never be re-collected).
              let commentBreakBeforeId = Infinity;
              for (const comment of freshNewComments) {
                try {
                  const communityEvent: CommunityEvent = {
                    sourceEventId: `prcomment:${repoFullName}#${prNumber}:${comment.id}`,
                    subjectKey,
                    kind: 'pr.review_submitted',
                    classification: 'informational',
                    payload: {
                      commentId: comment.id,
                      author: comment.author,
                      authorAssociation: comment.authorAssociation,
                      commentType: comment.commentType,
                    },
                    at: new Date(comment.createdAt).getTime(),
                  };
                  const { appended: commentAppended } = await opts.eventLog.append(communityEvent);
                  // Cloud R8 P1-2: only project newly appended events (appended:true).
                  // Duplicate events (appended:false) are already in the log at their original
                  // temporal position; applying them again out of order undoes state transitions
                  // (e.g. case.awaiting_external → in_progress revert from stale PR activity).
                  if (commentAppended && opts.projector) {
                    await opts.projector.apply(communityEvent);
                  }
                  maxSafeCommentCursor = Math.max(maxSafeCommentCursor, comment.id);
                  processedComments.push(comment);
                } catch {
                  // append or projector.apply failed (including repair failure) — break so cursor
                  // stays before this comment; next poll retries it and all subsequent comments.
                  commentBreakBeforeId = comment.id; // R18 P1: record break boundary
                  opts.log.warn(
                    `[review-feedback] processing failed for comment ${comment.id} on ${prKey} — will retry`,
                  );
                  break;
                }
              }
              let reviewBreakBeforeId = Infinity;
              for (const review of freshNewReviews) {
                try {
                  const communityEvent: CommunityEvent = {
                    // R4-P1-A: matches webhook handler format for idempotent dual-path convergence
                    sourceEventId: `review:${repoFullName}#${prNumber}:${review.id}`,
                    subjectKey,
                    kind: 'pr.review_submitted',
                    classification: 'informational',
                    payload: {
                      reviewId: review.id,
                      author: review.author,
                      authorAssociation: review.authorAssociation,
                      reviewState: review.state,
                    },
                    at: new Date(review.submittedAt).getTime(),
                  };
                  const { appended: reviewAppended } = await opts.eventLog.append(communityEvent);
                  // Cloud R8 P1-2: only project newly appended events (appended:true).
                  if (reviewAppended && opts.projector) {
                    await opts.projector.apply(communityEvent);
                  }
                  maxSafeReviewCursor = Math.max(maxSafeReviewCursor, review.id);
                  processedReviews.push(review);
                } catch {
                  reviewBreakBeforeId = review.id; // R18 P1: record break boundary
                  opts.log.warn(`[review-feedback] processing failed for review ${review.id} on ${prKey} — will retry`);
                  break;
                }
              }
              // R5-P2: narrow delivery to items that completed event-log processing without error.
              safeDeliveryComments = processedComments;
              safeDeliveryReviews = processedReviews;

              // Cloud R16 P2: advance cursor past stale items (those filtered by isStaleCommitFeedback).
              // Staleness is a delivery policy filter — a comment on an old commit is recognized and
              // deliberately not delivered, but it must still advance the cursor. Without this, when
              // ALL new comments are stale, maxSafeCommentCursor stays at commentCursor and advanceCursor
              // is called with the same value → cursor never moves → infinite polling churn.
              //
              // Cloud R18 P1: gate stale advancement by the fresh-loop break boundary. If the fresh
              // loop broke at id=X (append/projector failure), stale items with id >= X must NOT
              // advance the cursor — they lie beyond the failure point and advancing there would
              // silently drop the failed fresh item from the retry queue.
              for (const c of allNewComments) {
                if (isStaleCommitFeedback(c, prMetadata?.headSha) && c.id < commentBreakBeforeId) {
                  maxSafeCommentCursor = Math.max(maxSafeCommentCursor, c.id);
                }
              }
              for (const r of allNewReviews) {
                if (isStaleCommitFeedback(r, prMetadata?.headSha) && r.id < reviewBreakBeforeId) {
                  maxSafeReviewCursor = Math.max(maxSafeReviewCursor, r.id);
                }
              }
            }

            const commentFilter = opts.isEchoComment;
            const noiseFilter = opts.isNoiseComment;
            const reviewFilter = opts.isEchoReview;
            // R5-P2: use safeDeliveryXxx (items up to first failure) so items after a break are
            // not notified this round — they will be retried next poll without double-notification.
            const newComments = safeDeliveryComments.filter((c) => {
              if (commentFilter?.(c)) return false;
              if (noiseFilter?.(c)) return false;
              // F168 Phase B: apply delivery policy — OWNER/MEMBER activity is silent-log
              const decision = decideDelivery({
                state: 'in_progress', // stateless function — state field not used
                eventKind: 'pr.review_submitted',
                authorAssociation: c.authorAssociation as
                  | import('@cat-cafe/shared').GitHubAuthorAssociation
                  | undefined,
              });
              if (decision === 'silent-log') return false;
              return true;
            });
            const newDecisions = (
              reviewFilter ? safeDeliveryReviews.filter((r) => !reviewFilter(r)) : safeDeliveryReviews
            ).filter((r) => {
              // F168 Phase B: apply delivery policy — OWNER/MEMBER review decisions are silent-log
              const decision = decideDelivery({
                state: 'in_progress', // stateless function — state field not used
                eventKind: 'pr.review_submitted',
                authorAssociation: r.authorAssociation as
                  | import('@cat-cafe/shared').GitHubAuthorAssociation
                  | undefined,
              });
              return decision !== 'silent-log';
            });

            // R4-P1-B: when eventLog is configured, cap cursor advancement at the last
            // successfully projected item (maxSafeXxxCursor). Items beyond a projection
            // failure are excluded, ensuring they are retried on the next poll.
            // Without eventLog, fall back to the original all-new-items max (no change).
            const maxCommentId =
              opts.eventLog && task.subjectKey
                ? maxSafeCommentCursor
                : allNewComments.length > 0
                  ? Math.max(...allNewComments.map((c) => c.id))
                  : commentCursor;
            const maxReviewId =
              opts.eventLog && task.subjectKey
                ? maxSafeReviewCursor
                : allNewReviews.length > 0
                  ? Math.max(...allNewReviews.map((r) => r.id))
                  : reviewCursor;

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
      async execute(signal: ReviewFeedbackSignal, subjectKey: string, _ctx: ExecuteContext) {
        const { task } = signal;
        const maxReviews = opts.maxReviewsPerThread ?? 3;
        const completedCount = task.automationState?.review?.completedReviewCount ?? 0;
        const originalThreadId = task.threadId;

        // #949: Pre-dispatch thread rotation — when the current thread has processed
        // too many reviews, create a fresh thread to avoid context overflow.
        // Sonnet overflows at ~3 MRs, Opus at ~5; default threshold is 3 (conservative).
        let effectiveThreadId = originalThreadId;
        if (opts.threadStore && completedCount >= maxReviews) {
          try {
            // Preserve projectPath from the original thread so that cats invoked
            // in the rotated thread resolve the correct working directory (#949 cloud P1).
            const originalThread = await opts.threadStore.get(originalThreadId);
            const newThread = await opts.threadStore.create(
              task.userId ?? '',
              `MR review (auto-rotated from ${task.threadId})`,
              originalThread?.projectPath,
            );
            effectiveThreadId = newThread.id;
            await opts.taskStore.update(task.id, { threadId: newThread.id });
            opts.log.info(
              `[review-feedback] Thread rotated: ${task.threadId} → ${newThread.id} (${completedCount} reviews completed)`,
            );
          } catch (e) {
            // Rotation failed — fall back to original thread (best-effort)
            opts.log.warn(
              `[review-feedback] Thread rotation failed for ${subjectKey}, continuing with original thread`,
              e,
            );
          }
        }

        const routeResult = await opts.reviewFeedbackRouter.route(
          {
            repoFullName: signal.repoFullName,
            prNumber: signal.prNumber,
            newComments: signal.newComments,
            newDecisions: signal.newDecisions,
          },
          {
            threadId: effectiveThreadId,
            catId: task.ownerCatId ?? '',
            userId: task.userId ?? '',
            trackingInstructions: task.automationState?.trackingInstructions,
          },
        );

        if (routeResult.kind !== 'notified') return;

        await signal.commitCursor();

        // #949: Increment completedReviewCount after successful delivery.
        // If thread was rotated, reset to 1 (this delivery is the first on the new thread).
        const newCount = effectiveThreadId !== originalThreadId ? 1 : completedCount + 1;
        try {
          await opts.taskStore.patchAutomationState(task.id, {
            review: { completedReviewCount: newCount },
          });
        } catch (e) {
          opts.log.warn(`[review-feedback] completedReviewCount update failed for ${subjectKey}`, e);
        }

        if (opts.invokeTrigger) {
          try {
            const hasChangesRequested = signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED');
            const hasApproved = !hasChangesRequested && signal.newDecisions.some((d) => d.state === 'APPROVED');
            const suggestedSkill = hasChangesRequested ? 'receive-review' : hasApproved ? 'merge-gate' : undefined;
            const coalesceTargetCatId = routeResult.catId || task.ownerCatId || 'unassigned';

            const policy: ConnectorTriggerPolicy = {
              priority: hasChangesRequested ? 'urgent' : 'normal',
              reason: 'github_review_feedback',
              sourceCategory: 'review',
              suggestedSkill,
              coalesceKey: `${subjectKey}:review-feedback:${coalesceTargetCatId}`,
            };
            void opts.invokeTrigger
              .trigger(
                routeResult.threadId,
                routeResult.catId as CatId,
                task.userId ?? '',
                routeResult.content,
                routeResult.messageId,
                undefined,
                policy,
              )
              .catch((err) =>
                opts.log.warn(
                  { err },
                  `[review-feedback] trigger failed for ${signal.repoFullName}#${signal.prNumber} (best-effort)`,
                ),
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

function isStaleCommitFeedback(item: { readonly commitId?: string }, currentHeadSha?: string): boolean {
  return Boolean(currentHeadSha && item.commitId && item.commitId !== currentHeadSha);
}
