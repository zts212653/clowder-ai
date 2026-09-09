/**
 * F139 + F140 + clowder-ai#320: ConflictCheckTaskSpec — detect PR merge conflicts via injectable check.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → checkMergeable per PR → build ConflictSignals.
 * Execute: ConflictRouter handles dedup/delivery → ConnectorInvokeTrigger wakes cat.
 *
 * KD-9: Gate passes ALL mergeState results (including MERGEABLE) so ConflictRouter
 *       can clear fingerprints for re-conflict detection.
 */
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import { hasPendingGitHubWaitOutcome } from '../../domains/github-signals/GitHubWaitLifecycleService.js';
import { claimableSourceCategory, mayAutoWakeOwner } from '../../domains/github-signals/WaitWakeDisposition.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { AutoResolveResult, ConflictAutoExecutor } from './ConflictAutoExecutor.js';
import type { ConflictRouter, ConflictSignal } from './ConflictRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';

export interface ConflictCheckTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly checkMergeable: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<{ mergeState: string; mergeStateStatus?: string; headSha: string; isBehind: boolean }>;
  readonly conflictRouter: ConflictRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly autoExecutor?: ConflictAutoExecutor;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  readonly id?: string;
}

type ConflictWorkItem = { signal: ConflictSignal; task: TaskItem } | { recoveryOnly: true; task: TaskItem };

async function tryAutoResolveBeforeWake(
  opts: ConflictCheckTaskSpecOptions,
  workItem: ConflictWorkItem,
  signal?: AbortSignal,
): Promise<AutoResolveResult | null> {
  if (
    'recoveryOnly' in workItem ||
    !opts.autoExecutor ||
    workItem.signal.mergeState !== 'CONFLICTING' ||
    signal?.aborted
  )
    return null;
  try {
    return await opts.autoExecutor.resolve(
      workItem.signal.repoFullName,
      workItem.signal.prNumber,
      workItem.signal.headSha,
      signal,
    );
  } catch (error) {
    if (!signal?.aborted) throw error;
    opts.log.warn({ error }, '[conflict-check] cancellation interrupted optional auto-resolution; waking owner');
    return null;
  }
}

export function createConflictCheckTaskSpec(opts: ConflictCheckTaskSpecOptions): TaskSpec_P1<ConflictWorkItem> {
  return {
    id: opts.id ?? 'conflict-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 5 * 60 * 1000 },
    admission: {
      async gate() {
        // A terminal transition marks the task done before connector delivery. Keep a durable
        // pending outcome reachable from this independently configurable schedule until replay.
        const tasks = (await opts.taskStore.listByKind('pr_tracking')).filter(
          (task) => task.status !== 'done' || hasPendingGitHubWaitOutcome(task),
        );
        if (tasks.length === 0) {
          return { run: false, reason: 'no tracked PRs' };
        }

        const workItems: { signal: ConflictWorkItem; subjectKey: string }[] = [];
        for (const task of tasks) {
          try {
            const parsed = task.subjectKey ? parsePrSubjectKey(task.subjectKey) : null;
            if (!parsed) continue;
            const { repoFullName, prNumber } = parsed;

            if (hasPendingGitHubWaitOutcome(task)) {
              workItems.push({ signal: { recoveryOnly: true, task }, subjectKey: task.subjectKey! });
              continue;
            }

            const { mergeState, mergeStateStatus, headSha, isBehind } = await opts.checkMergeable(
              repoFullName,
              prNumber,
            );
            workItems.push({
              signal: {
                signal: {
                  repoFullName,
                  prNumber,
                  headSha,
                  mergeState,
                  ...(mergeStateStatus ? { mergeStateStatus } : {}),
                  isBehind,
                },
                task,
              },
              subjectKey: task.subjectKey!,
            });
          } catch (err) {
            opts.log.warn(
              { err, taskId: task.id, subjectKey: task.subjectKey },
              '[conflict-check] fail-open: skipping PR where check failed',
            );
          }
        }

        if (workItems.length === 0) {
          return { run: false, reason: 'no tracked PRs with checkable state' };
        }

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(workItem: ConflictWorkItem, _subjectKey: string, ctx: ExecuteContext) {
        ctx.signal?.throwIfAborted();
        const routeResult =
          'recoveryOnly' in workItem
            ? await opts.conflictRouter.recoverPending(workItem.task.id)
            : await opts.conflictRouter.route(workItem.signal);
        if (routeResult.kind !== 'notified') return;

        // F140 Phase C auto-resolve REWRITES the branch (rebase + push). Only the conflict event
        // authorizes that. This router emits `pr_head_changed` on every poll, so "notified" alone
        // let a tracker that had explicitly EXCLUDED `conflict` trigger a branch rewrite.
        //
        // Gate the REWRITE, never the wake: a head-only match is still a match the owner
        // subscribed to, and returning early here would suppress the notification it earned —
        // trading a write bug for a silent-mute bug, which A26 ranks as the worse one.
        // `?? []` denies rather than permits: an absent kind list must never authorize a branch
        // rewrite. This is the one direction in which a permissive default is not acceptable.
        if (!('recoveryOnly' in workItem) && (routeResult.matchedKinds ?? []).includes('pr_became_conflicting')) {
          const result = await tryAutoResolveBeforeWake(opts, workItem, ctx.signal);
          if (result?.kind === 'resolved') {
            opts.log.info(`[conflict-check] Auto-resolved conflict for ${result.branch} (${result.method})`);
            return;
          }
          if (result?.kind === 'escalated') {
            opts.log.info(`[conflict-check] Escalating: ${result.files.length} conflict file(s) in ${result.branch}`);
          }
        }

        // sol R33: same shared outcome, same rule — a conflict poll that re-published a
        // suppressed Review outcome must deliver it and stop there.
        if (opts.invokeTrigger && mayAutoWakeOwner(routeResult)) {
          // sol R34: ...and an unevaluated re-publish must not borrow THIS signal's conflict
          // either. `urgent` + `github_pr_conflict` is a claim about the subject's state; when the
          // outcome being delivered was created by another adapter, this poll evaluated nothing
          // and has no such claim to make. It still wakes — the owner is owed the delivery — just
          // without a verdict this observation never established.
          const evaluated = routeResult.observationEvaluated;
          const policy: ConnectorTriggerPolicy = {
            priority: evaluated ? 'urgent' : 'normal',
            reason: evaluated ? 'github_pr_conflict' : 'github_wait_satisfied',
            sourceCategory: claimableSourceCategory(routeResult, 'conflict'),
          };
          await opts.invokeTrigger
            .trigger(
              routeResult.threadId,
              routeResult.catId as CatId,
              workItem.task.userId ?? '',
              routeResult.content,
              routeResult.messageId,
              undefined,
              policy,
            )
            .catch((err) => opts.log.warn({ err }, '[conflict-check] trigger failed (best-effort)'));
          opts.log.info(`[conflict-check] Triggered ${routeResult.catId} for PR conflict`);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: '冲突检测',
      category: 'pr',
      description: '检测 tracked PR 是否有合并冲突',
      subjectKind: 'pr',
    },
  };
}
