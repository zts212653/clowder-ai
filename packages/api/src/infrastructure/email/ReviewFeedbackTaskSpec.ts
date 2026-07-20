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
import {
  DEFAULT_THREAD_ID,
  type IThreadStore,
  type Thread,
} from '../../domains/cats/services/stores/ports/ThreadStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import type { DistillationCheckpoint } from '../distillation/DistillationCheckpoint.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type {
  PrFeedbackComment,
  PrReviewDecision,
  ReviewFeedbackRouter,
  ReviewFeedbackRoutingAudit,
} from './ReviewFeedbackRouter.js';

export interface ReviewFeedbackSignal {
  repairedTask: TaskItem;
  repoFullName: string;
  prNumber: number;
  routingAudit?: ReviewFeedbackRoutingAudit;
  newComments: PrFeedbackComment[];
  newDecisions: PrReviewDecision[];
  validateRoutingRepairFresh?: () => Promise<boolean>;
  commitRoutingRepair?: () => Promise<boolean>;
  commitCursor: () => Promise<void>;
}

export interface ReviewFeedbackPrMetadata {
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
  /** PR title from GitHub — used by distillation checkpoint to extract featureId/phaseLabel. */
  readonly prTitle?: string;
}

export interface PrFeedbackCommentCursors {
  readonly inline: number;
  readonly conversation: number;
}

export interface ReviewFeedbackTaskSpecOptions {
  readonly taskStore: ITaskStore;
  /** Return null when PR metadata is temporarily unavailable; gate will continue without head/state filtering. */
  readonly fetchPrMetadata?: (repoFullName: string, prNumber: number) => Promise<ReviewFeedbackPrMetadata | null>;
  /** Each GitHub endpoint has an independent numeric ID space and therefore its own cursor. */
  readonly fetchComments: (
    repoFullName: string,
    prNumber: number,
    cursors: PrFeedbackCommentCursors,
  ) => Promise<PrFeedbackComment[]>;
  /** @param sinceId — when provided, only fetch items with id > sinceId (enables per-page early termination). */
  readonly fetchReviews: (repoFullName: string, prNumber: number, sinceId?: number) => Promise<PrReviewDecision[]>;
  readonly reviewFeedbackRouter: ReviewFeedbackRouter;
  /**
   * Legacy #949 repair only: read thread metadata to detect already-created
   * "MR review (auto-rotated from <threadId>)" threads and move PR tracking
   * ownership back to the original registration thread.
   */
  readonly threadStore?: Pick<IThreadStore, 'get'>;
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
  // F208 Phase E AC-E2: distillation checkpoint (best-effort, optional)
  readonly distillationCheckpoint?: DistillationCheckpoint;
  /** F167 Phase Q: retire matching hold_ball timers once structured review feedback is delivered. */
  readonly holdLifecycle?: {
    retireSatisfiedWait(event: {
      threadId: string;
      subjectKey: string;
      expectedSignalKey: 'review_posted';
      sourceKind: 'review_feedback';
      sourceMessageId?: string;
    }): void | Promise<unknown>;
  };
}

function resolveCursor(memoryCursor: number | undefined, persistedCursor: number | undefined): number {
  return Math.max(memoryCursor ?? 0, persistedCursor ?? 0);
}

function collectLegacyPrCommentProjectionKeys(
  events: readonly CommunityEvent[],
  repoFullName: string,
  prNumber: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const event of events) {
    const commentId = event.payload.commentId;
    const commentType = event.payload.commentType;
    if (
      typeof commentId === 'number' &&
      (commentType === 'inline' || commentType === 'conversation') &&
      event.sourceEventId === `prcomment:${repoFullName}#${prNumber}:${commentId}`
    ) {
      keys.add(`${commentType}:${commentId}`);
    }
  }
  return keys;
}

const LEGACY_ROTATED_REVIEW_THREAD_RE = /^MR review \(auto-rotated from ([^)]+)\)$/;
const MAX_LEGACY_ROTATION_REPAIR_HOPS = 10;

function parseLegacyRotatedSourceThreadId(title: string | null | undefined): string | null {
  const match = title?.match(LEGACY_ROTATED_REVIEW_THREAD_RE);
  const threadId = match?.[1]?.trim();
  return threadId ? threadId : null;
}

function hasTrustedLegacyParticipants(task: TaskItem, thread: Thread): boolean {
  if (thread.participants.length === 0) return true;
  return thread.participants.every((participant) => participant === task.ownerCatId);
}

function isTrustedLegacyRotatedThread(task: TaskItem, currentThread: Thread, sourceThread: Thread): boolean {
  const userId = task.userId?.trim();
  if (!userId) return false;
  const sourceIsBuiltInDefault = sourceThread.id === DEFAULT_THREAD_ID && sourceThread.createdBy === 'system';
  if (currentThread.createdBy !== userId) return false;
  if (sourceThread.createdBy !== userId && !sourceIsBuiltInDefault) return false;
  if (currentThread.projectPath && sourceThread.projectPath && currentThread.projectPath !== sourceThread.projectPath) {
    return false;
  }
  if (!hasTrustedLegacyParticipants(task, currentThread)) return false;
  if (currentThread.createdAt < task.createdAt) return false;
  return true;
}

interface LegacyRotatedTaskRepairResult {
  readonly task: TaskItem;
  readonly routingAudit?: ReviewFeedbackRoutingAudit;
  readonly validateRoutingRepairFresh?: () => Promise<boolean>;
  readonly commitRoutingRepair?: () => Promise<boolean>;
}

export function createReviewFeedbackTaskSpec(opts: ReviewFeedbackTaskSpecOptions): TaskSpec_P1<ReviewFeedbackSignal> {
  // GitHub inline review comments and PR conversation comments use independent ID spaces.
  const inlineCommentCursors = new Map<string, number>();
  const conversationCommentCursors = new Map<string, number>();
  const reviewCursors = new Map<string, number>();

  async function repairLegacyRotatedTask(task: TaskItem): Promise<LegacyRotatedTaskRepairResult> {
    if (!opts.threadStore) return { task };

    try {
      let currentThread = await opts.threadStore.get(task.threadId);
      if (!currentThread) return { task };
      let sourceThreadId = parseLegacyRotatedSourceThreadId(currentThread?.title);
      if (!sourceThreadId || sourceThreadId === task.threadId) return { task };

      const visitedThreadIds = new Set<string>([task.threadId]);
      let repairTargetThreadId = sourceThreadId;
      let reachedOriginalThread = false;

      for (let hop = 0; hop < MAX_LEGACY_ROTATION_REPAIR_HOPS; hop += 1) {
        if (visitedThreadIds.has(sourceThreadId)) {
          opts.log.warn(
            `[review-feedback] legacy rotated thread repair skipped for ${task.subjectKey ?? task.id}: rotation backlink cycle at ${sourceThreadId}`,
          );
          return { task };
        }

        const sourceThread = await opts.threadStore.get(sourceThreadId);
        if (!sourceThread) {
          opts.log.warn(
            `[review-feedback] legacy rotated thread repair skipped for ${task.subjectKey ?? task.id}: source thread ${sourceThreadId} not found`,
          );
          return { task };
        }
        if (!isTrustedLegacyRotatedThread(task, currentThread, sourceThread)) {
          opts.log.warn(
            `[review-feedback] legacy rotated thread repair skipped for ${task.subjectKey ?? task.id}: thread ownership metadata did not match trusted #949 shape`,
          );
          return { task };
        }

        repairTargetThreadId = sourceThreadId;
        visitedThreadIds.add(sourceThreadId);

        const nextSourceThreadId = parseLegacyRotatedSourceThreadId(sourceThread.title);
        if (!nextSourceThreadId || nextSourceThreadId === sourceThread.id) {
          reachedOriginalThread = true;
          break;
        }

        currentThread = sourceThread;
        sourceThreadId = nextSourceThreadId;
      }

      if (!reachedOriginalThread) {
        opts.log.warn(
          `[review-feedback] legacy rotated thread repair skipped for ${task.subjectKey ?? task.id}: rotation backlink chain exceeded ${MAX_LEGACY_ROTATION_REPAIR_HOPS} hops`,
        );
        return { task };
      }

      const previousThreadId = task.threadId;
      const validateRoutingRepairFresh = async () => {
        const currentTask = await opts.taskStore.get(task.id);
        if (!currentTask) {
          throw new Error(`task not found: ${task.id}`);
        }
        if (currentTask.threadId !== previousThreadId) {
          opts.log.warn(
            `[review-feedback] skipped stale legacy rotated thread repair for ${task.id}: task moved from ${previousThreadId} to ${currentTask.threadId}`,
          );
          return false;
        }
        return true;
      };
      const commitRoutingRepair = async () => {
        if (!(await validateRoutingRepairFresh())) return false;
        const repaired = await opts.taskStore.updateIfThreadId(task.id, previousThreadId, {
          threadId: repairTargetThreadId,
        });
        if (!repaired) {
          opts.log.warn(
            `[review-feedback] skipped stale legacy rotated thread repair for ${task.id}: task moved before conditional update`,
          );
          return false;
        }
        opts.log.info(
          `[review-feedback] repaired legacy rotated thread for ${task.id}: ${task.threadId} → ${repairTargetThreadId}`,
        );
        return true;
      };
      return {
        task: {
          ...task,
          threadId: repairTargetThreadId,
        },
        routingAudit: {
          kind: 'legacy-auto-rotated-repaired',
          previousThreadId,
          repairedThreadId: repairTargetThreadId,
        },
        validateRoutingRepairFresh,
        commitRoutingRepair,
      };
    } catch (e) {
      opts.log.warn(`[review-feedback] legacy rotated thread repair failed for ${task.subjectKey ?? task.id}`, e);
      return { task };
    }
  }

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
    cursors: { inline: number; conversation: number; decision: number },
    policy: 'persistFirst' | 'memoryFirst',
  ): Promise<void> {
    const patch = {
      review: {
        // Keep the v1 field as deprecated telemetry for readers not yet migrated.
        // It must never be used as an ordering boundary across the two sources.
        lastCommentCursor: Math.max(cursors.inline, cursors.conversation),
        lastInlineCommentCursor: cursors.inline,
        lastConversationCommentCursor: cursors.conversation,
        lastDecisionCursor: cursors.decision,
        ...(policy === 'memoryFirst' ? { lastNotifiedAt: Date.now() } : {}),
      },
    };
    const setMemory = () => {
      inlineCommentCursors.set(prKey, cursors.inline);
      conversationCommentCursors.set(prKey, cursors.conversation);
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
            const repairResult = await repairLegacyRotatedTask(task);
            const trackingTask = repairResult.task;

            const prMetadata = opts.fetchPrMetadata ? await opts.fetchPrMetadata(repoFullName, prNumber) : null;
            if (prMetadata?.prState === 'merged' || prMetadata?.prState === 'closed') {
              await opts.taskStore.patchAutomationState(trackingTask.id, { review: { prState: prMetadata.prState } });
              await opts.taskStore.update(trackingTask.id, { status: 'done' });
              opts.log.info(`[review-feedback] PR ${prKey} ${prMetadata.prState} — task marked done`);

              // F168 Phase A: emit pr.merged / pr.closed event (best-effort)
              if (opts.eventLog && trackingTask.subjectKey) {
                const subjectKey = trackingTask.subjectKey; // already in format pr:owner/repo#N
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

              // F208 AC-E2: distillation checkpoint on feat-phase-close (best-effort)
              if (opts.distillationCheckpoint && prMetadata.prState === 'merged') {
                try {
                  // Extract feature ID from PR title (e.g. "feat(F208): Phase E AC-E2 — ...")
                  // PR title is the canonical source; fall back to trackingInstructions.
                  const featureSource = prMetadata.prTitle ?? trackingTask.automationState?.trackingInstructions ?? '';
                  const featureMatch = featureSource.match(/\b[Ff](\d{2,4})\b/);
                  const featureId = featureMatch ? `F${featureMatch[1]}` : undefined;
                  if (featureId) {
                    const phaseMatch = featureSource.match(/[Pp]hase\s+([A-Z])/i);
                    await opts.distillationCheckpoint.onFeatPhaseClose({
                      prNumber,
                      repoFullName,
                      authorCatId: (trackingTask.ownerCatId ?? 'unknown') as string,
                      threadId: trackingTask.threadId,
                      featureId,
                      phaseLabel: phaseMatch?.[1] ?? 'unknown',
                    });
                  }
                } catch {
                  opts.log.warn(`[review-feedback] distillation checkpoint failed for ${prKey}`);
                }
              }

              continue;
            }

            // Schema v2: each comments endpoint owns its cursor. A task with only the
            // legacy combined cursor replays each source from zero once; duplicate
            // delivery is preferable to permanently hiding a lower-ID future comment.
            const reviewState = trackingTask.automationState?.review;
            const needsCommentCursorMigration =
              reviewState?.lastInlineCommentCursor === undefined ||
              reviewState.lastConversationCommentCursor === undefined;
            const inlineCommentCursor = resolveCursor(
              inlineCommentCursors.get(prKey),
              reviewState?.lastInlineCommentCursor,
            );
            const conversationCommentCursor = resolveCursor(
              conversationCommentCursors.get(prKey),
              reviewState?.lastConversationCommentCursor,
            );
            const reviewCursor = resolveCursor(reviewCursors.get(prKey), reviewState?.lastDecisionCursor);

            // #798: Pass cursor to fetch for per-page client-side filtering (eliminates maxBuffer crash)
            const [comments, reviews] = await Promise.all([
              opts.fetchComments(repoFullName, prNumber, {
                inline: inlineCommentCursor,
                conversation: conversationCommentCursor,
              }),
              opts.fetchReviews(repoFullName, prNumber, reviewCursor),
            ]);

            const allNewInlineComments = comments.filter(
              (c) => c.commentType === 'inline' && c.id > inlineCommentCursor,
            );
            const allNewConversationComments = comments.filter(
              (c) => c.commentType === 'conversation' && c.id > conversationCommentCursor,
            );
            const allNewComments = [...allNewInlineComments, ...allNewConversationComments];
            const allNewReviews = reviews.filter((r) => r.id > reviewCursor);
            const freshNewInlineComments = allNewInlineComments.filter(
              (c) => !isStaleCommitFeedback(c, prMetadata?.headSha),
            );
            const freshNewConversationComments = allNewConversationComments.filter(
              (c) => !isStaleCommitFeedback(c, prMetadata?.headSha),
            );
            const freshNewComments = [...freshNewInlineComments, ...freshNewConversationComments];
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
            let maxSafeInlineCommentCursor = inlineCommentCursor;
            let maxSafeConversationCommentCursor = conversationCommentCursor;
            let maxSafeReviewCursor = reviewCursor;
            // Default: all fresh items are eligible for delivery (no eventLog configured).
            let safeDeliveryComments: typeof freshNewComments = freshNewComments;
            let safeDeliveryReviews: typeof freshNewReviews = freshNewReviews;
            if (opts.eventLog && trackingTask.subjectKey) {
              const subjectKey = trackingTask.subjectKey;
              // A task may replay comment history either while migrating its legacy
              // combined cursor or after unregister/re-register resets the split cursors.
              // Community events outlive tracking tasks, so compatibility must follow
              // the permanent event history rather than the current task schema shape.
              // Payload commentType disambiguates equal numeric IDs from the two endpoints.
              const legacyProjectedCommentKeys =
                freshNewComments.length > 0
                  ? collectLegacyPrCommentProjectionKeys(await opts.eventLog.read(subjectKey), repoFullName, prNumber)
                  : new Set<string>();
              const processedInlineComments: typeof freshNewInlineComments = [];
              const processedConversationComments: typeof freshNewConversationComments = [];
              const processedReviews: typeof freshNewReviews = [];
              // Cloud R18 P1: track the id of the first fresh item that fails (break boundary).
              // The stale-cursor advancement loops must NOT advance past this boundary — otherwise
              // a stale item with a higher id would advance the cursor past the failed fresh item,
              // silently dropping it from the retry queue (it would never be re-collected).
              let inlineBreakBeforeId = Infinity;
              let conversationBreakBeforeId = Infinity;
              for (const [commentType, sourceComments] of [
                ['inline', freshNewInlineComments],
                ['conversation', freshNewConversationComments],
              ] as const) {
                for (const comment of sourceComments) {
                  try {
                    const communityEvent: CommunityEvent = {
                      sourceEventId: `prcomment:${repoFullName}#${prNumber}:${commentType}:${comment.id}`,
                      subjectKey,
                      kind: 'pr.review_submitted',
                      classification: 'informational',
                      payload: {
                        commentId: comment.id,
                        author: comment.author,
                        authorAssociation: comment.authorAssociation,
                        commentType,
                      },
                      at: new Date(comment.createdAt).getTime(),
                    };
                    const legacyProjectionExists = legacyProjectedCommentKeys.has(`${commentType}:${comment.id}`);
                    const commentAppended = legacyProjectionExists
                      ? false
                      : (await opts.eventLog.append(communityEvent)).appended;
                    if (commentAppended && opts.projector) {
                      await opts.projector.apply(communityEvent);
                    }
                    if (commentType === 'inline') {
                      maxSafeInlineCommentCursor = Math.max(maxSafeInlineCommentCursor, comment.id);
                      processedInlineComments.push(comment);
                    } else {
                      maxSafeConversationCommentCursor = Math.max(maxSafeConversationCommentCursor, comment.id);
                      processedConversationComments.push(comment);
                    }
                  } catch {
                    if (commentType === 'inline') inlineBreakBeforeId = comment.id;
                    else conversationBreakBeforeId = comment.id;
                    opts.log.warn(
                      `[review-feedback] processing failed for ${commentType} comment ${comment.id} on ${prKey} — will retry`,
                    );
                    break;
                  }
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
              safeDeliveryComments = [...processedInlineComments, ...processedConversationComments];
              safeDeliveryReviews = processedReviews;

              // Cloud R16 P2: advance cursor past stale items (those filtered by isStaleCommitFeedback).
              // Staleness is a delivery policy filter — a comment on an old commit is recognized and
              // deliberately not delivered, but it must still advance the cursor. Without this, when
              // ALL new comments are stale, the source cursor otherwise stays unchanged and advanceCursor
              // is called with the same value → cursor never moves → infinite polling churn.
              //
              // Cloud R18 P1: gate stale advancement by the fresh-loop break boundary. If the fresh
              // loop broke at id=X (append/projector failure), stale items with id >= X must NOT
              // advance the cursor — they lie beyond the failure point and advancing there would
              // silently drop the failed fresh item from the retry queue.
              for (const c of allNewInlineComments) {
                if (isStaleCommitFeedback(c, prMetadata?.headSha) && c.id < inlineBreakBeforeId) {
                  maxSafeInlineCommentCursor = Math.max(maxSafeInlineCommentCursor, c.id);
                }
              }
              for (const c of allNewConversationComments) {
                if (isStaleCommitFeedback(c, prMetadata?.headSha) && c.id < conversationBreakBeforeId) {
                  maxSafeConversationCommentCursor = Math.max(maxSafeConversationCommentCursor, c.id);
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
            // #1002: decideDelivery removed — it silenced OWNER/MEMBER reviews,
            // but PR tracking is opt-in (cat explicitly registered), so ALL reviewer
            // feedback should be delivered. isEchoComment + isNoiseComment are sufficient.
            const newComments = safeDeliveryComments.filter((c) => {
              if (commentFilter?.(c)) return false;
              if (noiseFilter?.(c)) return false;
              return true;
            });
            // #1002: same — isEchoReview is the only filter needed for review decisions.
            const newDecisions = reviewFilter
              ? safeDeliveryReviews.filter((r) => !reviewFilter(r))
              : safeDeliveryReviews;

            // R4-P1-B: when eventLog is configured, cap cursor advancement at the last
            // successfully projected item (maxSafeXxxCursor). Items beyond a projection
            // failure are excluded, ensuring they are retried on the next poll.
            // Without eventLog, fall back to the original all-new-items max (no change).
            const maxInlineCommentId =
              opts.eventLog && trackingTask.subjectKey
                ? maxSafeInlineCommentCursor
                : allNewInlineComments.length > 0
                  ? Math.max(...allNewInlineComments.map((c) => c.id))
                  : inlineCommentCursor;
            const maxConversationCommentId =
              opts.eventLog && trackingTask.subjectKey
                ? maxSafeConversationCommentCursor
                : allNewConversationComments.length > 0
                  ? Math.max(...allNewConversationComments.map((c) => c.id))
                  : conversationCommentCursor;
            const maxReviewId =
              opts.eventLog && trackingTask.subjectKey
                ? maxSafeReviewCursor
                : allNewReviews.length > 0
                  ? Math.max(...allNewReviews.map((r) => r.id))
                  : reviewCursor;

            const allSkipped = newComments.length === 0 && newDecisions.length === 0;
            const hadNewItems = allNewComments.length > 0 || allNewReviews.length > 0;
            if (allSkipped && !repairResult.routingAudit) {
              if (hadNewItems || needsCommentCursorMigration) {
                await advanceCursor(
                  trackingTask.id,
                  prKey,
                  { inline: maxInlineCommentId, conversation: maxConversationCommentId, decision: maxReviewId },
                  'persistFirst',
                );
              }
              continue;
            }

            workItems.push({
              signal: {
                repairedTask: trackingTask,
                repoFullName,
                prNumber,
                routingAudit: repairResult.routingAudit,
                newComments,
                newDecisions,
                validateRoutingRepairFresh: repairResult.validateRoutingRepairFresh,
                commitRoutingRepair: repairResult.commitRoutingRepair,
                commitCursor: () =>
                  advanceCursor(
                    trackingTask.id,
                    prKey,
                    { inline: maxInlineCommentId, conversation: maxConversationCommentId, decision: maxReviewId },
                    'memoryFirst',
                  ),
              },
              // #320 KD-15: unified subject_key format
              subjectKey: trackingTask.subjectKey!,
            });
          } catch (err) {
            opts.log.warn(
              { err, taskId: task.id, subjectKey: task.subjectKey },
              '[review-feedback] fail-open: skipping PR where fetch failed',
            );
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
        const { repairedTask } = signal;

        if (signal.validateRoutingRepairFresh && !(await signal.validateRoutingRepairFresh())) {
          return;
        }

        const routeResult = await opts.reviewFeedbackRouter.route(
          {
            repoFullName: signal.repoFullName,
            prNumber: signal.prNumber,
            routingAudit: signal.routingAudit,
            newComments: signal.newComments,
            newDecisions: signal.newDecisions,
          },
          {
            threadId: repairedTask.threadId,
            catId: repairedTask.ownerCatId ?? '',
            userId: repairedTask.userId ?? '',
            trackingInstructions: repairedTask.automationState?.trackingInstructions,
          },
        );

        if (routeResult.kind !== 'notified') return;

        const repairCommitted = await signal.commitRoutingRepair?.();
        if (repairCommitted === false) return;
        await signal.commitCursor();

        if (opts.holdLifecycle) {
          try {
            await opts.holdLifecycle.retireSatisfiedWait({
              threadId: routeResult.threadId,
              subjectKey,
              expectedSignalKey: 'review_posted',
              sourceKind: 'review_feedback',
              sourceMessageId: routeResult.messageId,
            });
          } catch (err) {
            opts.log.warn({ err, subjectKey }, '[review-feedback] hold lifecycle retirement failed (best-effort)');
          }
        }

        if (opts.invokeTrigger) {
          try {
            const hasChangesRequested = signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED');
            const hasApproved = !hasChangesRequested && signal.newDecisions.some((d) => d.state === 'APPROVED');
            const suggestedSkill = hasChangesRequested ? 'receive-review' : hasApproved ? 'merge-gate' : undefined;
            const coalesceTargetCatId = routeResult.catId || repairedTask.ownerCatId || 'unassigned';

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
                repairedTask.userId ?? '',
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

        // F208 AC-E2: distillation checkpoint on review-complete (best-effort, all approvals)
        if (opts.distillationCheckpoint) {
          const approvals = signal.newDecisions.filter((d) => d.state === 'APPROVED');
          for (const approver of approvals) {
            try {
              await opts.distillationCheckpoint.onReviewComplete({
                prNumber: signal.prNumber,
                repoFullName: signal.repoFullName,
                reviewerCatId: (approver.author ?? 'unknown') as string,
                authorCatId: (repairedTask.ownerCatId ?? 'unknown') as string,
                threadId: repairedTask.threadId,
              });
            } catch {
              opts.log.warn(
                `[review-feedback] distillation checkpoint (review) failed for ${signal.repoFullName}#${signal.prNumber} reviewer=${approver.author}`,
              );
            }
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
