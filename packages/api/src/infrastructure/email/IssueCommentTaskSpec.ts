/**
 * F202 Phase 2D: IssueCommentTaskSpec — poll GitHub issue comments for issue_tracking tasks.
 *
 * Mirrors ReviewFeedbackTaskSpec pattern:
 * Gate: list issue_tracking tasks → fetch comments → filter by cursor → workItems.
 * Execute: IssueCommentRouter → commitCursor.
 * Auto-close: issue closed → task marked done (AC-D4).
 */
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { parseIssueSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IssueComment, IssueCommentRouter } from './IssueCommentRouter.js';

export interface IssueCommentSignal {
  task: TaskItem;
  repoFullName: string;
  issueNumber: number;
  newComments: IssueComment[];
  commitCursor: () => Promise<void>;
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
}

function resolveCommentCursor(memoryCursor: number | undefined, persistedCursor: number | undefined): number {
  return Math.max(memoryCursor ?? 0, persistedCursor ?? 0);
}

export function createIssueCommentTaskSpec(opts: IssueCommentTaskSpecOptions): TaskSpec_P1<IssueCommentSignal> {
  const commentCursors = new Map<string, number>();

  async function advanceCursor(
    taskId: string,
    issueKey: string,
    cursor: number,
    policy: 'persistFirst' | 'memoryFirst',
  ): Promise<void> {
    const patch = {
      issue: {
        lastCommentCursor: cursor,
        ...(policy === 'memoryFirst' ? { lastNotifiedAt: Date.now() } : {}),
      },
    };
    const setMemory = () => {
      commentCursors.set(issueKey, cursor);
    };

    if (policy === 'memoryFirst') {
      setMemory();
      try {
        await opts.taskStore.patchAutomationState(taskId, patch);
      } catch (e) {
        opts.log.warn(`[issue-comment] cursor persist failed for ${issueKey}, restart may replay`, e);
      }
    } else {
      try {
        await opts.taskStore.patchAutomationState(taskId, patch);
        setMemory();
      } catch (e) {
        opts.log.warn(`[issue-comment] echo-skip persist failed for ${issueKey}, will retry next tick`, e);
      }
    }
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

            // AC-D4: Check issue state (fetch before comment processing so
            // pending comments are delivered before auto-close — P2-cloud fix)
            const issueState = await opts.fetchIssueState(repoFullName, issueNumber);

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
              await advanceCursor(task.id, issueKey, maxCommentId, 'persistFirst');
            }

            // AC-D4: Issue closed → deliver pending comments first, then auto-close
            if (issueState === 'closed') {
              if (newComments.length > 0) {
                // Deliver final comments; commitCursor also marks task done
                workItems.push({
                  signal: {
                    task,
                    repoFullName,
                    issueNumber,
                    newComments,
                    commitCursor: async () => {
                      await advanceCursor(task.id, issueKey, maxCommentId, 'memoryFirst');
                      await opts.taskStore.update(task.id, { status: 'done' });
                      await opts.taskStore.patchAutomationState(task.id, { issue: { issueState: 'closed' } });
                      opts.log.info(`[issue-comment] Issue ${issueKey} closed — final comments delivered, task done`);
                    },
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
                commitCursor: () => advanceCursor(task.id, issueKey, maxCommentId, 'memoryFirst'),
              },
              subjectKey: task.subjectKey!,
            });
          } catch {
            // fail-open: skip issues where fetch fails
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
        const routeResult = await opts.issueCommentRouter.route(
          {
            repoFullName: signal.repoFullName,
            issueNumber: signal.issueNumber,
            newComments: signal.newComments,
          },
          {
            threadId: task.threadId,
            catId: task.ownerCatId ?? '',
            userId: task.userId ?? '',
            trackingInstructions: task.automationState?.trackingInstructions,
          },
        );

        if (routeResult.kind !== 'notified') return;

        await signal.commitCursor();

        if (opts.invokeTrigger) {
          try {
            const coalesceTargetCatId = routeResult.catId || task.ownerCatId || 'unassigned';
            const policy: ConnectorTriggerPolicy = {
              priority: 'normal',
              reason: 'github_issue_comment',
              sourceCategory: 'issue',
              coalesceKey: `${subjectKey}:issue-comment:${coalesceTargetCatId}`,
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
                  `[issue-comment] trigger failed for ${signal.repoFullName}#${signal.issueNumber} (best-effort)`,
                  err,
                ),
              );
          } catch {
            opts.log.warn(
              `[issue-comment] trigger failed for ${signal.repoFullName}#${signal.issueNumber} (best-effort)`,
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
      label: 'Issue 评论',
      category: 'issue',
      description: '监控 GitHub Issue 评论通知猫猫',
      subjectKind: 'issue',
    },
  };
}
