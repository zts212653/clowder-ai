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
import { pullRequestReviewEventId } from '../../domains/community/community-keys.js';
import type {
  ExternalCloudObservation,
  ExternalReviewCoordinatorResult,
  ExternalReviewTrackingTarget,
} from '../../domains/community/external-review/ExternalReviewCoordinator.js';
import { deriveCloudReviewObservation } from '../../domains/github-signals/CloudReviewObservation.js';
import { normalizePrFeedbackBatch } from '../../domains/github-signals/GitHubTrackingEvent.js';
import {
  classifyGitHubReviewLoopBrake,
  type GitHubReviewLoopBrake,
} from '../../domains/github-signals/github-wait-renderer.js';
import { claimableSourceCategory, mayAutoWakeOwner } from '../../domains/github-signals/WaitWakeDisposition.js';
import type { DistillationCheckpoint } from '../distillation/DistillationCheckpoint.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type {
  PrFeedbackComment,
  PrReviewDecision,
  ReviewFeedbackRouter,
  ReviewFeedbackRoutingAudit,
} from './ReviewFeedbackRouter.js';
import { projectReviewFeedbackTerminalEffects } from './ReviewFeedbackTerminalEffects.js';

export interface ReviewFeedbackSignal {
  repairedTask: TaskItem;
  repoFullName: string;
  prNumber: number;
  routingAudit?: ReviewFeedbackRoutingAudit;
  newComments: PrFeedbackComment[];
  newDecisions: PrReviewDecision[];
  headSha: string;
  inlineCommentCursor: number;
  conversationCommentCursor: number;
  decisionCursor: number;
  activeDecisionStatesByReviewId: Readonly<Record<string, 'APPROVED' | 'CHANGES_REQUESTED'>>;
  subjectState?: 'merged' | 'closed';
  reviewLoopBrake?: GitHubReviewLoopBrake;
  validateRoutingRepairFresh?: () => Promise<boolean>;
  commitRoutingRepair?: () => Promise<boolean>;
  commitCursor: () => Promise<void>;
}

export interface ReviewFeedbackPrMetadata {
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
  readonly authorLogin?: string;
  readonly authorType?: string;
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
  /**
   * Return the complete current review set. GitHub mutates a dismissed verdict in place without
   * assigning a new review id, so cursor-filtered collection cannot observe revocation.
   */
  readonly fetchReviews: (repoFullName: string, prNumber: number) => Promise<PrReviewDecision[]>;
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
   * F168: current-HEAD cloud-review readiness. Fed from the normalized bot round rather than
   * from a caller-registered predicate — see CloudReviewObservation.
   */
  readonly externalReviewCoordinator?: {
    recordCloud(
      observation: ExternalCloudObservation,
      tracking: ExternalReviewTrackingTarget,
    ): Promise<ExternalReviewCoordinatorResult>;
  };
  readonly now?: () => number;
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  readonly id?: string;
  // F168 Phase A: community event log + projector (best-effort, optional)
  readonly eventLog?: ICommunityEventLog;
  readonly projector?: { apply(event: CommunityEvent): Promise<void> };
  // F208 Phase E AC-E2: distillation checkpoint (best-effort, optional)
  readonly distillationCheckpoint?: DistillationCheckpoint;
}

function resolveCursor(memoryCursor: number | undefined, persistedCursor: number | undefined): number {
  return Math.max(memoryCursor ?? 0, persistedCursor ?? 0);
}

function compareFeedbackChronology(a: PrFeedbackComment, b: PrFeedbackComment): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }
  return 0;
}

function activeReviewDecisionState(review: PrReviewDecision): 'APPROVED' | 'CHANGES_REQUESTED' | undefined {
  return review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' ? review.state : undefined;
}

function reviewProcessingKey(review: PrReviewDecision): string {
  return `${review.id}:${review.state}`;
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

function resolveReviewLoopBrake(input: {
  history: readonly PrReviewDecision[];
  prAuthorLogin?: string;
  newDecisions: readonly PrReviewDecision[];
}): GitHubReviewLoopBrake | undefined {
  const changesRequested = input.newDecisions.filter((review) => review.state === 'CHANGES_REQUESTED');
  if (changesRequested.length === 0) return undefined;
  return classifyGitHubReviewLoopBrake(
    input.history,
    changesRequested.map((review) => review.id),
    input.prAuthorLogin,
  );
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
    cursors: {
      inline: number;
      conversation: number;
      decision: number;
      activeDecisionStatesByReviewId: Readonly<Record<string, 'APPROVED' | 'CHANGES_REQUESTED'>>;
      commentMigrationPending?: boolean;
      commentMigrationTargets?: PrFeedbackCommentCursors;
    },
    policy: 'persistFirst' | 'memoryFirst',
  ): Promise<void> {
    const patch = {
      review: {
        // Keep the v1 field as deprecated telemetry for readers not yet migrated.
        // It must never be used as an ordering boundary across the two sources.
        lastCommentCursor: Math.max(cursors.inline, cursors.conversation),
        lastInlineCommentCursor: cursors.inline,
        lastConversationCommentCursor: cursors.conversation,
        ...(cursors.commentMigrationPending !== undefined
          ? { commentCursorMigrationPending: cursors.commentMigrationPending }
          : {}),
        ...(cursors.commentMigrationTargets ? { commentCursorMigrationTargets: cursors.commentMigrationTargets } : {}),
        lastDecisionCursor: cursors.decision,
        activeDecisionStatesByReviewId: cursors.activeDecisionStatesByReviewId,
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
            const trackingSubjectKey = trackingTask.subjectKey ?? task.subjectKey;
            if (!trackingSubjectKey) continue;

            const prMetadata = opts.fetchPrMetadata ? await opts.fetchPrMetadata(repoFullName, prNumber) : null;
            const terminalState =
              prMetadata?.prState === 'merged' || prMetadata?.prState === 'closed' ? prMetadata.prState : undefined;

            // Schema v2: each comments endpoint owns its cursor. A task with only the
            // legacy combined cursor replays each source from zero. That backfill is
            // durable state migration, never live feedback: waking on it would replay
            // historical humans after a deploy/restart. A pending marker keeps retries
            // state-only if one endpoint fails before its initial observed frontier;
            // activity beyond that snapshot remains live while migration retries.
            const reviewState = trackingTask.automationState?.review;
            const inlineCommentCursorMissing = reviewState?.lastInlineCommentCursor === undefined;
            const conversationCommentCursorMissing = reviewState?.lastConversationCommentCursor === undefined;
            const commentCursorMigrationWasPending = reviewState?.commentCursorMigrationPending === true;
            const commentCursorMigrationActive =
              commentCursorMigrationWasPending || inlineCommentCursorMissing || conversationCommentCursorMissing;
            const inlineCommentCursor = resolveCursor(
              inlineCommentCursors.get(prKey),
              reviewState?.lastInlineCommentCursor,
            );
            const conversationCommentCursor = resolveCursor(
              conversationCommentCursors.get(prKey),
              reviewState?.lastConversationCommentCursor,
            );
            const reviewCursor = resolveCursor(reviewCursors.get(prKey), reviewState?.lastDecisionCursor);
            const previousActiveDecisionStates = reviewState?.activeDecisionStatesByReviewId;
            const reviewDecisionStateMigration = previousActiveDecisionStates === undefined;

            // #798 keeps each endpoint page bounded. Comment records are immutable and may be
            // cursor-filtered; formal reviews must remain visible because GitHub mutates a
            // dismissal in place under the original id.
            const [comments, reviews] = await Promise.all([
              opts.fetchComments(repoFullName, prNumber, {
                inline: inlineCommentCursor,
                conversation: conversationCommentCursor,
              }),
              // Unlike comments, reviews are mutable records: dismissal changes an old review's
              // state while preserving its id. fetchPaginated already visits every page because
              // GitHub serves this endpoint oldest-first, so returning the full normalized set
              // adds no API calls and makes the state comparison possible.
              opts.fetchReviews(repoFullName, prNumber),
            ]);

            // The two endpoints have independent cursor spaces, but their feedback still
            // belongs to one user-visible timeline. Keep cursor checks source-specific and
            // order the merged stream by creation time rather than grouping by endpoint.
            const allNewComments = comments
              .filter((c) =>
                c.commentType === 'inline' ? c.id > inlineCommentCursor : c.id > conversationCommentCursor,
              )
              .sort(compareFeedbackChronology);
            const allNewInlineComments = allNewComments.filter((c) => c.commentType === 'inline');
            const allNewConversationComments = allNewComments.filter((c) => c.commentType === 'conversation');
            const inlineCommentFrontier =
              allNewInlineComments.length > 0
                ? Math.max(...allNewInlineComments.map((comment) => comment.id))
                : inlineCommentCursor;
            const conversationCommentFrontier =
              allNewConversationComments.length > 0
                ? Math.max(...allNewConversationComments.map((comment) => comment.id))
                : conversationCommentCursor;
            const commentCursorMigrationTargets: PrFeedbackCommentCursors = {
              inline: commentCursorMigrationActive
                ? (reviewState?.commentCursorMigrationTargets?.inline ??
                  (inlineCommentCursorMissing ? inlineCommentFrontier : inlineCommentCursor))
                : inlineCommentCursor,
              conversation: commentCursorMigrationActive
                ? (reviewState?.commentCursorMigrationTargets?.conversation ??
                  (conversationCommentCursorMissing ? conversationCommentFrontier : conversationCommentCursor))
                : conversationCommentCursor,
            };
            const isCommentMigrationBackfill = (comment: PrFeedbackComment): boolean =>
              commentCursorMigrationActive &&
              (comment.commentType === 'inline'
                ? comment.id <= commentCursorMigrationTargets.inline
                : comment.id <= commentCursorMigrationTargets.conversation);
            const allNewReviews = reviews
              .flatMap((review) => {
                const previousState = previousActiveDecisionStates?.[String(review.id)];
                if (review.id > reviewCursor) return [review];
                if (review.state === 'DISMISSED' && previousState) return [{ ...review, previousState }];
                return [];
              })
              .sort((left, right) => left.id - right.id);
            const freshNewComments = allNewComments.filter((c) => !isStaleCommitFeedback(c, prMetadata?.headSha));
            const durableNewComments = allNewComments.filter(
              (comment) => isCommentMigrationBackfill(comment) || !isStaleCommitFeedback(comment, prMetadata?.headSha),
            );
            const freshNewReviews = allNewReviews.filter((r) => !isStaleCommitFeedback(r, prMetadata?.headSha));

            // F168 Phase B (R3-P1, R4-P1-A/B, R5-P1/P2): append all current-HEAD activity plus
            // legacy migration backfill to the event log BEFORE delivery filtering. Feedback
            // written against an older HEAD stays outside community projection, but tracking
            // still delivers it with an explicit stale-HEAD label; its source cursor advances.
            //
            // Safe cursor tracking (R4-P1-B): track max ID of successfully processed items.
            // Break on first append/projector failure so cursor stays before the failing item,
            // ensuring it is retried on the next poll (never permanently lost).
            //
            // Temporal ordering (Cloud R8 P1): appended=false means the event already has a
            // position in the log. Do not apply it out of order from this poller; reconciliation
            // rebuilds eventual projections from the event-log truth.
            //
            // sourceEventId alignment (R4-P1-A): an initial review uses
            // `review:{repo}#{pr}:{id}` to match the submitted webhook. A later in-place
            // dismissal uses the same base plus `:DISMISSED`, because it is a distinct durable
            // revision of that record. Comments use `prcomment:...` (unique to polling — PR
            // conversation/inline comments are skipped by the webhook).
            let maxSafeInlineCommentCursor = inlineCommentCursor;
            let maxSafeConversationCommentCursor = conversationCommentCursor;
            let maxSafeReviewCursor = reviewCursor;
            const processedReviewKeys = new Set<string>();
            if (opts.eventLog && trackingTask.subjectKey) {
              const subjectKey = trackingTask.subjectKey;
              // A task may replay comment history either while migrating its legacy
              // combined cursor or after unregister/re-register resets the split cursors.
              // Community events outlive tracking tasks, so compatibility must follow
              // the permanent event history rather than the current task schema shape.
              // Payload commentType disambiguates equal numeric IDs from the two endpoints.
              const legacyProjectedCommentKeys =
                durableNewComments.length > 0
                  ? collectLegacyPrCommentProjectionKeys(await opts.eventLog.read(subjectKey), repoFullName, prNumber)
                  : new Set<string>();
              // Cloud R18 P1: track the id of the first fresh item that fails (break boundary).
              // The stale-cursor advancement loops must NOT advance past this boundary — otherwise
              // a stale item with a higher id would advance the cursor past the failed fresh item,
              // silently dropping it from the retry queue (it would never be re-collected).
              let inlineBreakBeforeId = Infinity;
              let conversationBreakBeforeId = Infinity;
              const blockedCommentSources = new Set<'inline' | 'conversation'>();
              for (const comment of durableNewComments) {
                const commentType = comment.commentType;
                // A failure blocks only its endpoint. The other endpoint has an
                // independent cursor and can continue safely through this timeline.
                if (blockedCommentSources.has(commentType)) continue;
                try {
                  const communityEvent: CommunityEvent = {
                    sourceEventId: `prcomment:${repoFullName}#${prNumber}:${commentType}:${comment.id}`,
                    subjectKey,
                    kind: 'pr.review_submitted',
                    classification: 'informational',
                    payload: {
                      commentId: comment.id,
                      author: comment.author,
                      actorType: comment.actorType,
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
                  } else {
                    maxSafeConversationCommentCursor = Math.max(maxSafeConversationCommentCursor, comment.id);
                  }
                } catch {
                  blockedCommentSources.add(commentType);
                  if (commentType === 'inline') inlineBreakBeforeId = comment.id;
                  else conversationBreakBeforeId = comment.id;
                  opts.log.warn(
                    `[review-feedback] processing failed for ${commentType} comment ${comment.id} on ${prKey} — will retry`,
                  );
                }
              }
              let reviewBreakBeforeId = Infinity;
              for (const review of freshNewReviews) {
                try {
                  const communityEvent: CommunityEvent = {
                    // R4-P1-A: matches webhook handler format for idempotent dual-path convergence
                    sourceEventId: pullRequestReviewEventId(
                      repoFullName,
                      prNumber,
                      review.id,
                      review.previousState ? 'DISMISSED' : undefined,
                    ),
                    subjectKey,
                    kind: 'pr.review_submitted',
                    classification: 'informational',
                    payload: {
                      reviewId: review.id,
                      author: review.author,
                      actorType: review.actorType,
                      authorAssociation: review.authorAssociation,
                      reviewState: review.state,
                      ...(review.previousState ? { previousReviewState: review.previousState } : {}),
                    },
                    at: new Date(review.submittedAt).getTime(),
                  };
                  const { appended: reviewAppended } = await opts.eventLog.append(communityEvent);
                  // Cloud R8 P1-2: only project newly appended events (appended:true).
                  if (reviewAppended && opts.projector) {
                    await opts.projector.apply(communityEvent);
                  }
                  maxSafeReviewCursor = Math.max(maxSafeReviewCursor, review.id);
                  processedReviewKeys.add(reviewProcessingKey(review));
                } catch {
                  reviewBreakBeforeId = review.id; // R18 P1: record break boundary
                  opts.log.warn(`[review-feedback] processing failed for review ${review.id} on ${prKey} — will retry`);
                  break;
                }
              }
              // Cloud R16 P2: advance cursor past stale items (those filtered from community
              // projection by isStaleCommitFeedback). Tracking still delivers them with a stale-HEAD
              // label, but without this accounting an all-stale batch leaves the source cursor
              // unchanged and replays forever.
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

            // R4-P1-B: when eventLog is configured, cap cursor advancement at the last
            // successfully projected item (maxSafeXxxCursor). Items beyond a projection
            // failure are excluded from BOTH delivery and cursor advancement, ensuring they
            // are retried on the next poll. Advancing only the cursor while routing the whole
            // fetched batch let lifecycle state outrun durable history.
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
            const durableNewReviews =
              opts.eventLog && trackingTask.subjectKey
                ? allNewReviews.filter(
                    (review) =>
                      review.id <= maxReviewId &&
                      (isStaleCommitFeedback(review, prMetadata?.headSha) ||
                        processedReviewKeys.has(reviewProcessingKey(review))),
                  )
                : allNewReviews;
            const activeDecisionStatesByReviewId: Record<string, 'APPROVED' | 'CHANGES_REQUESTED'> = {
              ...(previousActiveDecisionStates ?? {}),
            };
            // Existing tasks have no state snapshot. Seed only already-consumed reviews so a
            // deployment does not replay historical dismissals; registrations created by this
            // version arrive with the snapshot already frozen by GitHubWaitBaselineReader.
            if (reviewDecisionStateMigration) {
              for (const review of reviews) {
                const state = activeReviewDecisionState(review);
                if (review.id <= reviewCursor && state) activeDecisionStatesByReviewId[String(review.id)] = state;
              }
            }
            for (const review of durableNewReviews) {
              const state = activeReviewDecisionState(review);
              if (state) activeDecisionStatesByReviewId[String(review.id)] = state;
              else if (review.state === 'DISMISSED') delete activeDecisionStatesByReviewId[String(review.id)];
            }
            const commentCursorMigrationPending =
              commentCursorMigrationActive &&
              (maxInlineCommentId < commentCursorMigrationTargets.inline ||
                maxConversationCommentId < commentCursorMigrationTargets.conversation);

            // Tracking carries the whole DURABLE source prefix. Self-authored items are not
            // dropped: they advance frontiers and open bot turns (F280 A28, "asked the bot and
            // heard nothing"). Only append/projection failures bound the per-source prefix;
            // the chain's identity row still decides who gets woken.
            const newComments = allNewComments.filter(
              (comment) =>
                !isCommentMigrationBackfill(comment) &&
                (comment.commentType === 'inline'
                  ? comment.id <= maxInlineCommentId
                  : comment.id <= maxConversationCommentId),
            );
            const newDecisions = durableNewReviews;
            const reviewFrontier =
              allNewReviews.length > 0 ? Math.max(...allNewReviews.map((review) => review.id)) : reviewCursor;
            const feedbackCollectionComplete =
              !commentCursorMigrationPending &&
              maxInlineCommentId >= inlineCommentFrontier &&
              maxConversationCommentId >= conversationCommentFrontier &&
              maxReviewId >= reviewFrontier &&
              durableNewReviews.length === allNewReviews.length;
            // A terminal lifecycle is allowed to end the task only after every feedback source
            // reached its observed frontier. Otherwise a same-poll append failure would mark the
            // task done and make the missing final feedback impossible to repair.
            const deliverTerminal = terminalState !== undefined && feedbackCollectionComplete;

            const reviewLoopBrake = resolveReviewLoopBrake({
              history: reviews,
              prAuthorLogin: prMetadata?.authorLogin,
              newDecisions,
            });

            const hadNewItems = allNewComments.length > 0 || allNewReviews.length > 0;
            const activeAwait = trackingTask.automationState?.await;
            const activePrBaseline =
              activeAwait && 'headSha' in activeAwait.baseline ? activeAwait.baseline : undefined;
            if (!activeAwait && !repairResult.routingAudit && !deliverTerminal) {
              if (hadNewItems || commentCursorMigrationActive || reviewDecisionStateMigration) {
                await advanceCursor(
                  trackingTask.id,
                  prKey,
                  {
                    inline: maxInlineCommentId,
                    conversation: maxConversationCommentId,
                    decision: maxReviewId,
                    activeDecisionStatesByReviewId,
                    ...(commentCursorMigrationActive
                      ? {
                          commentMigrationPending: commentCursorMigrationPending,
                          commentMigrationTargets: commentCursorMigrationTargets,
                        }
                      : {}),
                  },
                  'persistFirst',
                );
              }
              continue;
            }

            if (deliverTerminal) {
              opts.log.info(`[review-feedback] PR ${prKey} ${terminalState} — routing typed terminal lifecycle`);
              await projectReviewFeedbackTerminalEffects({
                opts,
                task: trackingTask,
                subjectKey: trackingSubjectKey,
                repoFullName,
                prNumber,
                terminalState,
                prTitle: prMetadata?.prTitle,
              });
            }

            // F168: report cloud-review readiness from the same normalized facts that drive the
            // round. Best-effort — tracking delivery must never depend on community bookkeeping.
            //
            // It is given the SAME normalized batch the router delivers from, not just the round
            // state left over from previous polls. Reading only the leftovers made a summon that
            // was answered inside one interval — the ordinary fast path — invisible: the round
            // opened and closed between two readings and left nothing behind.
            if (opts.externalReviewCoordinator && prMetadata?.headSha) {
              const observation = deriveCloudReviewObservation({
                headSha: prMetadata.headSha,
                comments: newComments,
                decisions: newDecisions,
                events: normalizePrFeedbackBatch({
                  headSha: prMetadata.headSha,
                  comments: newComments,
                  decisions: newDecisions,
                  ...(opts.isEchoComment ? { isSelfComment: opts.isEchoComment } : {}),
                  ...(opts.isEchoReview ? { isSelfReview: opts.isEchoReview } : {}),
                }),
                now: (opts.now ?? Date.now)(),
                ...(activePrBaseline?.botTurns ? { openTurns: activePrBaseline.botTurns } : {}),
              });
              if (observation) {
                try {
                  await opts.externalReviewCoordinator.recordCloud(
                    { repoFullName, prNumber, headSha: prMetadata.headSha, ...observation },
                    {
                      threadId: trackingTask.threadId,
                      catId: trackingTask.ownerCatId ?? '',
                      userId: trackingTask.userId ?? '',
                    },
                  );
                } catch (err) {
                  opts.log.warn({ err, repoFullName, prNumber }, '[F168] cloud-review bookkeeping failed');
                }
              }
            }

            workItems.push({
              signal: {
                repairedTask: trackingTask,
                repoFullName,
                prNumber,
                routingAudit: repairResult.routingAudit,
                newComments,
                newDecisions,
                headSha: prMetadata?.headSha ?? activePrBaseline?.headSha ?? '',
                inlineCommentCursor: maxInlineCommentId,
                conversationCommentCursor: maxConversationCommentId,
                decisionCursor: maxReviewId,
                activeDecisionStatesByReviewId,
                ...(deliverTerminal ? { subjectState: terminalState } : {}),
                ...(reviewLoopBrake ? { reviewLoopBrake } : {}),
                validateRoutingRepairFresh: repairResult.validateRoutingRepairFresh,
                commitRoutingRepair: repairResult.commitRoutingRepair,
                commitCursor: () =>
                  advanceCursor(
                    trackingTask.id,
                    prKey,
                    {
                      inline: maxInlineCommentId,
                      conversation: maxConversationCommentId,
                      decision: maxReviewId,
                      activeDecisionStatesByReviewId,
                      ...(commentCursorMigrationActive
                        ? {
                            commentMigrationPending: commentCursorMigrationPending,
                            commentMigrationTargets: commentCursorMigrationTargets,
                          }
                        : {}),
                    },
                    'persistFirst',
                  ),
              },
              // #320 KD-15: unified subject_key format
              subjectKey: trackingSubjectKey,
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
      async execute(signal: ReviewFeedbackSignal, subjectKey: string, ctx: ExecuteContext) {
        ctx.signal?.throwIfAborted();
        const { repairedTask } = signal;

        if (signal.validateRoutingRepairFresh && !(await signal.validateRoutingRepairFresh())) {
          return;
        }
        ctx.signal?.throwIfAborted();

        const repairCommitted = await signal.commitRoutingRepair?.();
        if (repairCommitted === false) return;
        ctx.signal?.throwIfAborted();
        const routeResult = await opts.reviewFeedbackRouter.route(
          {
            repoFullName: signal.repoFullName,
            prNumber: signal.prNumber,
            headSha: signal.headSha,
            routingAudit: signal.routingAudit,
            newComments: signal.newComments,
            newDecisions: signal.newDecisions,
            inlineCommentCursor: signal.inlineCommentCursor,
            conversationCommentCursor: signal.conversationCommentCursor,
            decisionCursor: signal.decisionCursor,
            activeDecisionStatesByReviewId: signal.activeDecisionStatesByReviewId,
            ...(signal.subjectState ? { subjectState: signal.subjectState } : {}),
            ...(opts.isEchoComment ? { isSelfComment: opts.isEchoComment } : {}),
            ...(opts.isEchoReview ? { isSelfReview: opts.isEchoReview } : {}),
            ...(signal.reviewLoopBrake ? { reviewLoopBrake: signal.reviewLoopBrake } : {}),
          },
          { taskId: repairedTask.id },
        );
        // The source cursor and the lifecycle frontier move only after routing has
        // durably admitted (or deliberately ignored) the observation. A router error
        // therefore retries the same upstream event instead of losing it forever.
        //
        // sol R30: "notified" was not enough to mean that. When an earlier outcome is still
        // undelivered, the wait re-publishes it and never reads the items in THIS signal — and
        // this comment's promise was quietly false, because the cursor advanced past feedback
        // nothing had evaluated. Since #1394 installs outcome N with await N+1 atomically, that
        // is an ordinary state, not a rare race. Leaving the cursor put costs one poll cycle;
        // advancing it loses the item forever.
        //
        // R33 correction: a delivered outcome does NOT "always wake" — it wakes unless the
        // outcome itself suppressed it. That decision is shared across every adapter that can
        // re-publish it, so it is read through `mayAutoWakeOwner`, never re-derived here.
        //
        // sol R31: this flag governs the CURSOR only. Returning early on it also skipped the
        // wake, which swapped one silent loss for another: a re-published N reached the
        // connector but never Queue-admitted its owner, and the next round folded N into the
        // renewed baseline so it could never match again. R33 corrects the last sentence this
        // paragraph used to end on: a delivered outcome wakes UNLESS its own suppression says
        // otherwise, which is why the check below reads the outcome instead of this signal.
        //
        // sol R32: `kind` is not the question. A CAS-exhausted skip installs no baseline and no
        // outcome, so treating every non-`notified` shape as evaluated advanced the cursor past
        // feedback nothing had ever seen — the same loss, one shape over. Every result now
        // carries its own answer and this reads it uniformly.
        const evaluated = routeResult.observationEvaluated;
        if (evaluated) await signal.commitCursor();
        if (routeResult.kind !== 'notified') return;

        // R4 brake (upstream main): after four formal changes-requested reviews, pause the
        // automatic re-request exactly once so the owner reads the pattern instead of looping.
        //
        // Read from the DELIVERED OUTCOME, not from `signal`: when an earlier outcome is
        // re-published the signal describes a different observation, and taking the decision
        // from it let a connector hiccup cancel the pause the brake exists to enforce.
        if (!mayAutoWakeOwner(routeResult)) return;

        if (opts.invokeTrigger) {
          // A re-publish is shaped by the outcome that was delivered, never by the signal that
          // was not evaluated. Urgency is deliberately not inferred for it: the stored outcome
          // carries no structured verdict, and reading its prose is what section 2.4 forbids.
          // Under-claiming priority delays a wake; inventing one asserts a verdict we never saw.
          const hasChangesRequested =
            evaluated && signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED' && !opts.isEchoReview?.(d));
          const terminalState = evaluated ? signal.subjectState : routeResult.terminalSubjectState;
          const policy: ConnectorTriggerPolicy = {
            priority: hasChangesRequested ? 'urgent' : 'normal',
            reason:
              terminalState === 'merged'
                ? 'github_pr_merged'
                : terminalState === 'closed'
                  ? 'github_pr_closed'
                  : 'github_wait_satisfied',
            // Symmetric to the CI and conflict paths: a CI-created outcome re-published here is
            // not review provenance just because the review adapter drew the delivery.
            sourceCategory: claimableSourceCategory(routeResult, 'review'),
            coalesceKey: `${subjectKey}:wait:${routeResult.catId || 'unassigned'}`,
          };
          try {
            await opts.invokeTrigger.trigger(
              routeResult.threadId,
              routeResult.catId as CatId,
              repairedTask.userId ?? '',
              routeResult.content,
              routeResult.messageId,
              undefined,
              policy,
            );
          } catch (err) {
            opts.log.warn(
              { err },
              `[review-feedback] trigger failed for ${signal.repoFullName}#${signal.prNumber} (best-effort)`,
            );
          }
        }

        // F208 AC-E2: distillation checkpoint on review-complete (best-effort, all approvals)
        if (opts.distillationCheckpoint) {
          const approvals = signal.newDecisions.filter((d) => d.state === 'APPROVED' && !opts.isEchoReview?.(d));
          for (const approver of approvals) {
            ctx.signal?.throwIfAborted();
            try {
              await opts.distillationCheckpoint.onReviewComplete({
                prNumber: signal.prNumber,
                repoFullName: signal.repoFullName,
                reviewerCatId: (approver.author ?? 'unknown') as string,
                authorCatId: (repairedTask.ownerCatId ?? 'unknown') as string,
                threadId: repairedTask.threadId,
              });
              ctx.signal?.throwIfAborted();
            } catch {
              ctx.signal?.throwIfAborted();
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
