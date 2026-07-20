/**
 * F202 Phase 2D: IssueCommentTaskSpec — poll GitHub issue comments for issue_tracking tasks.
 *
 * Mirrors ReviewFeedbackTaskSpec pattern:
 * Gate: list issue_tracking tasks → fetch comments → filter by cursor → workItems.
 * Execute: IssueCommentRouter → persist pending wake → durable trigger admission → acknowledge wake.
 * Auto-close: issue closed → task marked done (AC-D4).
 *
 * F168 Phase B Task 4: Dual-cursor semantics when eventLog is injected.
 *   Collection cursor (lastCommentCursor): advances on successful event-log append, independent of delivery.
 *   Delivery cursor (lastDeliveredCursor): advances after routing or intentional echo suppression.
 *   Notification time (lastNotifiedAt): advances only after the owner wake is accepted.
 *   With no eventLog injected: original single-cursor behaviour is unchanged.
 */
import type { CatId, CommunityEvent, IssuePendingWake, TaskItem } from '@cat-cafe/shared';
import { parseIssueSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import { issueCommentEventId } from '../../domains/community/community-keys.js';
import type { ExecuteContext, TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IssueComment, IssueCommentRouter } from './IssueCommentRouter.js';

export interface IssueCommentSignal {
  task: TaskItem;
  repoFullName: string;
  issueNumber: number;
  newComments: IssueComment[];
  readonly deliveredCursor?: number;
  readonly retryWake?: IssuePendingWake;
  readonly commitRoutedWake?: (wake: IssuePendingWake) => Promise<void>;
  readonly commitWakeAccepted: () => Promise<void>;
}

export interface IssueCommentTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly issueCommentRouter: IssueCommentRouter;
  readonly fetchComments: (repoFullName: string, issueNumber: number, sinceId?: number) => Promise<IssueComment[]>;
  readonly fetchIssueState: (repoFullName: string, issueNumber: number) => Promise<'open' | 'closed'>;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  readonly isEchoComment?: (comment: IssueComment) => boolean;
  readonly id?: string;
  /**
   * F168 Phase B: Community event log for dual-cursor collection/delivery separation.
   * When injected, every fetched comment is appended as an `issue.commented` event
   * and the collection cursor (lastCommentCursor) advances on successful append —
   * independent of whether the owner notification (delivery) succeeds.
   * Comments that have not reached the thread are retried from lastDeliveredCursor
   * without re-appending to the event log.
   */
  readonly eventLog?: ICommunityEventLog;
  /**
   * F168 Phase B (Cloud R4 P1-1, revised Cloud R8 P1-1): Community projector.
   * When injected, each newly appended `issue.commented` event is applied to update
   * the case projection (awaiting_external → in_progress, lastExternalActivityAt)
   * without requiring a full rebuild.
   * Only applied when append() returns appended:true (new event). Duplicates
   * (appended:false) are skipped to preserve temporal ordering — applying an old event
   * after case.awaiting_external would incorrectly restore in_progress.
   */
  readonly projector?: { apply(event: CommunityEvent): Promise<void> };
}

function resolveCommentCursor(memoryCursor: number | undefined, persistedCursor: number | undefined): number {
  return Math.max(memoryCursor ?? 0, persistedCursor ?? 0);
}

export function createIssueCommentTaskSpec(opts: IssueCommentTaskSpecOptions): TaskSpec_P1<IssueCommentSignal> {
  // Collection cursors (lastCommentCursor) — used in both single and dual-cursor mode
  const commentCursors = new Map<string, number>();
  // Delivery cursors (lastDeliveredCursor) — only used in dual-cursor mode (eventLog present)
  const deliveryCursors = new Map<string, number>();

  async function advanceCursor(taskId: string, issueKey: string, cursor: number): Promise<void> {
    const patch = {
      issue: {
        lastCommentCursor: cursor,
      },
    };
    try {
      await opts.taskStore.patchAutomationState(taskId, patch);
      commentCursors.set(issueKey, cursor);
    } catch (e) {
      opts.log.warn(`[issue-comment] collection cursor persist failed for ${issueKey}, will retry next tick`, e);
    }
  }

  /** Dual-cursor: advance lastDeliveredCursor (only when eventLog is present). */
  async function advanceDeliveryCursor(
    taskId: string,
    issueKey: string,
    cursor: number,
    notified = false,
  ): Promise<void> {
    try {
      await opts.taskStore.patchAutomationState(taskId, {
        issue: {
          lastDeliveredCursor: cursor,
          ...(notified ? { lastNotifiedAt: Date.now() } : {}),
        },
      });
      deliveryCursors.set(issueKey, cursor);
    } catch (e) {
      opts.log.warn(`[issue-comment] delivery cursor persist failed for ${issueKey}, will retry next tick`, e);
    }
  }

  async function persistRoutedWake(
    taskId: string,
    issueKey: string,
    wake: IssuePendingWake,
    advanceCollectionCursor = false,
  ): Promise<void> {
    // Persist first: this state is the recovery ledger for a connector message that
    // already exists but whose owner wake has not reached durable admission.
    await opts.taskStore.patchAutomationState(taskId, {
      issue: {
        ...(advanceCollectionCursor ? { lastCommentCursor: wake.deliveredCursor } : {}),
        lastDeliveredCursor: wake.deliveredCursor,
        pendingWake: wake,
      },
    });
    if (advanceCollectionCursor) commentCursors.set(issueKey, wake.deliveredCursor);
    deliveryCursors.set(issueKey, wake.deliveredCursor);
  }

  async function acknowledgeWake(taskId: string, issueKey: string): Promise<void> {
    await opts.taskStore.patchAutomationState(taskId, {
      issue: {
        pendingWake: null,
        lastNotifiedAt: Date.now(),
      },
    });
    opts.log.info(`[issue-comment] Issue ${issueKey} routed message wake accepted; tracking remains active`);
  }

  return {
    id: opts.id ?? 'issue-comment',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        const tasks = (await opts.taskStore.listByKind('issue_tracking')).filter((t) => t.status !== 'done');
        if (tasks.length === 0) {
          return { run: false, reason: 'no tracked issues' };
        }

        const workItems: { signal: IssueCommentSignal; subjectKey: string }[] = [];

        for (const task of tasks) {
          try {
            const parsed = task.subjectKey ? parseIssueSubjectKey(task.subjectKey) : null;
            if (!parsed) continue;
            const { repoFullName, issueNumber } = parsed;
            const issueKey = `${repoFullName}#${issueNumber}`;

            // Recovery takes precedence over collecting more GitHub activity. The
            // connector message is already persisted, so retry its original idempotency
            // key instead of routing the same comments into a duplicate thread message.
            const pendingWake = task.automationState?.issue?.pendingWake;
            if (pendingWake) {
              workItems.push({
                signal: {
                  task,
                  repoFullName,
                  issueNumber,
                  newComments: [],
                  retryWake: pendingWake,
                  commitWakeAccepted: () => acknowledgeWake(task.id, issueKey),
                },
                subjectKey: task.subjectKey!,
              });
              continue;
            }

            // AC-D4: Check issue state (fetch before comment processing so
            // pending comments are delivered before auto-close — P2-cloud fix)
            const issueState = await opts.fetchIssueState(repoFullName, issueNumber);

            if (opts.eventLog) {
              // ── F168 Phase B: Dual-cursor mode ──────────────────────────────────────
              // Collection cursor (lastCommentCursor): advances on event-log append success.
              // Delivery cursor (lastDeliveredCursor): advances after routing or echo suppression.
              // lastNotifiedAt separately records whether the owner wake was accepted.
              // The delivery cursor is always ≤ collection cursor.
              // Fetch since delivery cursor (lower bound) to retry undelivered comments.
              const collectionCursor = resolveCommentCursor(
                commentCursors.get(issueKey),
                task.automationState?.issue?.lastCommentCursor,
              );
              // Default: treat firstuse delivery cursor as equal to collection cursor to avoid
              // replaying old notifications when eventLog is first injected into a running system.
              const persistedDeliveryCursor = task.automationState?.issue?.lastDeliveredCursor ?? collectionCursor;
              const deliveryCursor = resolveCommentCursor(deliveryCursors.get(issueKey), persistedDeliveryCursor);

              // Fetch since delivery cursor (may include already-collected comments that weren't delivered)
              const fetchSince = Math.min(collectionCursor, deliveryCursor); // = deliveryCursor always
              const comments = await opts.fetchComments(repoFullName, issueNumber, fetchSince);
              const allPending = comments.filter((c) => c.id > fetchSince);

              // ── Collection pass: attempt append for ALL pending-delivery comments ────
              // Defensive idempotency: even if collectionCursor suggests the comment was
              // already collected, we try to append (event log dedup returns appended:false
              // safely). This handles the crash-recovery case where the app died after
              // collection but before cursor persistence — without re-advancing the cursor.
              //
              // Cloud R4 P1-1: apply projector after each append (regardless of appended flag).
              //   appended=true → project new event.
              //   appended=false → repair path: event already in log (webhook path); projector
              //     may not have been called before (prior round: append ok, projector threw).
              //     Apply again to repair. Matches ReviewFeedbackTaskSpec pattern.
              //
              // Cloud R4 P1-2: track processedComments (append + projector success).
              //   Delivery and silent-cursor advance use processedComments, not allPending.
              //   This ensures delivery never includes comments whose events failed to land
              //   in the event log, preserving collection-before-delivery semantics.
              const processedComments: (typeof allPending)[number][] = [];
              let newCollectionMax = collectionCursor;
              for (const c of allPending) {
                try {
                  const communityEvent: CommunityEvent = {
                    sourceEventId: issueCommentEventId(repoFullName, issueNumber, c.id),
                    subjectKey: task.subjectKey!,
                    kind: 'issue.commented',
                    classification: 'informational',
                    // Cloud P1: include authorAssociation so state machine can identify
                    // OWNER/MEMBER vs external on projector replay/rebuild — without it
                    // awaiting_external is always restored to in_progress for maintainer comments
                    payload: {
                      commentId: c.id,
                      authorLogin: c.author,
                      authorAssociation: c.authorAssociation,
                      body: c.body,
                    },
                    at: Date.now(),
                  };
                  const { appended } = await opts.eventLog.append(communityEvent);
                  // Cloud R8 P1-1: only project newly appended events (appended:true).
                  // Applying duplicate events (appended:false, webhook already landed them)
                  // out of temporal order corrupts awaiting_external — a stale old comment
                  // replayed after case.awaiting_external wrongly restores in_progress.
                  // If the projector is out of sync, repair via rebuildAll() not out-of-order replay.
                  if (appended && opts.projector) {
                    await opts.projector.apply(communityEvent);
                  }
                  // Cloud R3 P2: advance cursor for BOTH new (appended:true) AND duplicate
                  // (appended:false) results. A duplicate means the comment is already
                  // safely in the event log (e.g. via the webhook path); withholding cursor
                  // advancement creates unbounded polling churn because every subsequent poll
                  // re-fetches from the stale lower bound. Only thrown exceptions (transient
                  // failures where the comment may NOT be in the log) should prevent advancement
                  // — those are handled by the catch+break below.
                  if (c.id > newCollectionMax) {
                    newCollectionMax = c.id;
                  }
                  processedComments.push(c);
                } catch {
                  // Cloud R2 P1: stop advancing past the failed append/projection so the cursor
                  // cannot skip over this comment. Next poll re-fetches from the
                  // delivery cursor (still below the failed comment's ID) and retries.
                  // Without break: a later successful append could advance newCollectionMax
                  // past the failed comment, permanently excluding it from the event log
                  // (especially when the P2 silent-cursor advance also shifts deliveryCursor).
                  break;
                }
              }
              // Cloud R17 P1: one-time seed of lastDeliveredCursor for tasks registered without it.
              // Must happen BEFORE advancing the collection cursor. Without this, a crash/exit
              // between collection advance and routed-wake persistence leaves lastDeliveredCursor=undefined,
              // and the next poll's fallback (lastDeliveredCursor ?? collectionCursor) uses the
              // POST-advance value — silently losing the undelivered comment.
              // Seeding to collectionCursor (PRE-advance value) ensures the next poll's fallback
              // lands on the safe old cursor, so the comment is retried.
              // One-time: fires only when lastDeliveredCursor is absent (tasks created before the
              // registration fix, or unusual re-registration flows without lastDeliveredCursor).
              if (
                newCollectionMax > collectionCursor &&
                task.automationState?.issue?.lastDeliveredCursor === undefined
              ) {
                await advanceDeliveryCursor(task.id, issueKey, collectionCursor);
              }
              // Persist collection cursor advance (persistFirst: persist → then set memory)
              if (newCollectionMax > collectionCursor) {
                await advanceCursor(task.id, issueKey, newCollectionMax);
              }

              // ── Delivery pass: identify comments needing notification ───────────────
              // Cloud R4 P1-2: use processedComments (successfully collected+projected),
              // not allPending. This prevents delivering notifications for comments whose
              // events were not appended to the event log (failed collection).
              const echoFilter = opts.isEchoComment;
              const pendingDelivery = processedComments.filter((c) => {
                if (c.id <= deliveryCursor) return false;
                if (echoFilter && echoFilter(c)) return false;
                return true;
              });
              const processedDeliveryBoundary =
                processedComments.length > 0
                  ? Math.max(...processedComments.map((comment) => comment.id))
                  : deliveryCursor;

              if (issueState === 'closed') {
                // Issue closed: deliver final pending batch (if any), then mark done
                if (pendingDelivery.length > 0) {
                  workItems.push({
                    signal: {
                      task,
                      repoFullName,
                      issueNumber,
                      newComments: pendingDelivery,
                      deliveredCursor: processedDeliveryBoundary,
                      commitRoutedWake: (wake) => persistRoutedWake(task.id, issueKey, wake),
                      commitWakeAccepted: () => acknowledgeWake(task.id, issueKey),
                    },
                    subjectKey: task.subjectKey!,
                  });
                } else if (processedComments.length < allPending.length) {
                  // Cloud R6 P1-2: Collection failed midway — processedComments is shorter than
                  // allPending because the loop broke on an append/projector error. Do NOT mark
                  // done: the cursor is still before the failed comment so the next poll can retry.
                  // Marking done here would permanently stop retries on a transient failure.
                  opts.log.info(
                    `[issue-comment] Issue ${issueKey} closed but collection incomplete (${processedComments.length}/${allPending.length}) — will retry`,
                  );
                } else {
                  // No pending delivery AND all fetched comments were successfully collected
                  // (or no new comments at all) → safe to close the tracking task.
                  if (processedComments.length > 0) {
                    const maxSuppressedId = Math.max(...processedComments.map((c) => c.id));
                    await advanceDeliveryCursor(task.id, issueKey, maxSuppressedId);
                  }
                  await opts.taskStore.update(task.id, { status: 'done' });
                  await opts.taskStore.patchAutomationState(task.id, { issue: { issueState: 'closed' } });
                  opts.log.info(`[issue-comment] Issue ${issueKey} closed — task marked done`);
                }
                continue;
              }

              if (pendingDelivery.length === 0) {
                // All fetched comments were echoes. Advance the delivery cursor past them
                // without updating lastNotifiedAt to prevent permanent polling churn —
                // without this, min(collectionCursor, deliveryCursor) = deliveryCursor keeps
                // re-fetching the same echo batch on every poll interval.
                //
                // Cloud R4 P1-2: use processedComments (not allPending) so the delivery cursor
                // only advances past comments that were successfully collected+projected.
                // If collection broke midway, advancing past uncollected comments would
                // permanently hide them from future delivery.
                if (processedComments.length > 0) {
                  const maxEchoId = Math.max(...processedComments.map((c) => c.id));
                  await advanceDeliveryCursor(task.id, issueKey, maxEchoId);
                }
                continue;
              }

              workItems.push({
                signal: {
                  task,
                  repoFullName,
                  issueNumber,
                  newComments: pendingDelivery,
                  deliveredCursor: processedDeliveryBoundary,
                  commitRoutedWake: (wake) => persistRoutedWake(task.id, issueKey, wake),
                  commitWakeAccepted: () => acknowledgeWake(task.id, issueKey),
                },
                subjectKey: task.subjectKey!,
              });
            } else {
              // ── Legacy single-cursor mode (no eventLog) ──────────────────────────────
              const commentCursor = resolveCommentCursor(
                commentCursors.get(issueKey),
                task.automationState?.issue?.lastCommentCursor,
              );
              const comments = await opts.fetchComments(repoFullName, issueNumber, commentCursor);
              const allNewComments = comments.filter((c) => c.id > commentCursor);

              // Filter self-authored (echo) comments
              const echoFilter = opts.isEchoComment;
              const newComments = echoFilter ? allNewComments.filter((c) => !echoFilter(c)) : allNewComments;

              const maxCommentId =
                allNewComments.length > 0 ? Math.max(...allNewComments.map((c) => c.id)) : commentCursor;

              // All new items were echo → advance cursor without notification
              if (newComments.length === 0 && allNewComments.length > 0) {
                await advanceCursor(task.id, issueKey, maxCommentId);
              }

              // AC-D4: Issue closed → deliver pending comments first, then auto-close
              if (issueState === 'closed') {
                if (newComments.length > 0) {
                  // Deliver final comments; only a durable accepted wake marks the task done.
                  workItems.push({
                    signal: {
                      task,
                      repoFullName,
                      issueNumber,
                      newComments,
                      deliveredCursor: maxCommentId,
                      commitRoutedWake: (wake) => persistRoutedWake(task.id, issueKey, wake, true),
                      commitWakeAccepted: () => acknowledgeWake(task.id, issueKey),
                    },
                    subjectKey: task.subjectKey!,
                  });
                } else {
                  // No pending comments → close immediately
                  await opts.taskStore.update(task.id, { status: 'done' });
                  await opts.taskStore.patchAutomationState(task.id, { issue: { issueState: 'closed' } });
                  opts.log.info(`[issue-comment] Issue ${issueKey} closed — task marked done`);
                }
                continue;
              }

              if (newComments.length === 0) continue;

              workItems.push({
                signal: {
                  task,
                  repoFullName,
                  issueNumber,
                  newComments,
                  deliveredCursor: maxCommentId,
                  commitRoutedWake: (wake) => persistRoutedWake(task.id, issueKey, wake, true),
                  commitWakeAccepted: () => acknowledgeWake(task.id, issueKey),
                },
                subjectKey: task.subjectKey!,
              });
            }
          } catch (err) {
            opts.log.warn(
              { err, taskId: task.id, subjectKey: task.subjectKey },
              '[issue-comment] fail-open: skipping issue where fetch failed',
            );
          }
        }

        if (workItems.length === 0) {
          return { run: false, reason: 'no new comments' };
        }

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(signal: IssueCommentSignal, subjectKey: string, _ctx: ExecuteContext) {
        const { task } = signal;

        // Guard: ownerCatId and userId must be present — auto-registered tasks always
        // have both set via R13 (userId) and R14 (ownerCatId from case.routed payload).
        // Silently passing '' (the old ?? '' fallback) caused invocation failures without
        // any visible error. Log a warning and skip to surface misconfigured tasks instead.
        if (!task.ownerCatId || !task.userId) {
          opts.log.warn(
            `[issue-comment] skipping execute for ${subjectKey}: task ${task.id} missing ownerCatId or userId`,
          );
          return;
        }

        let wake = signal.retryWake;
        if (!wake) {
          const routeResult = await opts.issueCommentRouter.route(
            {
              repoFullName: signal.repoFullName,
              issueNumber: signal.issueNumber,
              newComments: signal.newComments,
            },
            {
              threadId: task.threadId,
              catId: task.ownerCatId,
              userId: task.userId,
              trackingInstructions: task.automationState?.trackingInstructions,
            },
          );

          if (routeResult.kind !== 'notified') return;
          wake = {
            threadId: routeResult.threadId,
            catId: routeResult.catId,
            content: routeResult.content,
            messageId: routeResult.messageId,
            deliveredCursor:
              signal.deliveredCursor ??
              (signal.newComments.length > 0 ? Math.max(...signal.newComments.map((comment) => comment.id)) : 0),
          };
          await signal.commitRoutedWake?.(wake);
        }

        let wakeAccepted = false;
        if (opts.invokeTrigger) {
          try {
            const coalesceTargetCatId = wake.catId || task.ownerCatId || 'unassigned';
            const policy: ConnectorTriggerPolicy = {
              priority: 'normal',
              reason: 'github_issue_comment',
              sourceCategory: 'issue',
              coalesceKey: `${subjectKey}:issue-comment:${coalesceTargetCatId}`,
            };
            const outcome = await opts.invokeTrigger.trigger(
              wake.threadId,
              wake.catId as CatId,
              task.userId,
              wake.content,
              wake.messageId,
              undefined,
              policy,
            );
            wakeAccepted = outcome === 'dispatched' || outcome === 'enqueued';
            if (!wakeAccepted) {
              opts.log.error(
                { taskId: task.id, subjectKey, threadId: wake.threadId, catId: wake.catId, outcome },
                '[issue-comment] wake was not accepted; routed message remains pending for retry',
              );
            }
          } catch (err) {
            opts.log.error(
              {
                err,
                taskId: task.id,
                subjectKey,
                threadId: wake.threadId,
                catId: wake.catId,
                outcome: 'error',
              },
              '[issue-comment] wake was not accepted; routed message remains pending for retry',
            );
          }
        } else {
          opts.log.error(
            {
              taskId: task.id,
              subjectKey,
              threadId: wake.threadId,
              catId: wake.catId,
              outcome: 'missing_trigger',
            },
            '[issue-comment] wake was not accepted; routed message remains pending for retry',
          );
        }

        if (wakeAccepted) {
          await signal.commitWakeAccepted();
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: 'Issue 评论',
      category: 'issue',
      description: '监控 GitHub Issue 评论通知猫猫',
      subjectKind: 'issue',
    },
  };
}
