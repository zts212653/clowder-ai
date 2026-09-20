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
import type { CatId, TaskItem, WaitOutcomeV1 } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { AutoResolveResult, ConflictAutoExecutor } from './ConflictAutoExecutor.js';
import type { ConflictRouter, ConflictSignal } from './ConflictRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';

export interface ConflictCheckTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly checkMergeable: (repoFullName: string, prNumber: number) => Promise<{ mergeState: string; headSha: string }>;
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

interface ConflictWorkItem {
  signal: ConflictSignal;
  task: TaskItem;
}

/**
 * #1392 R5: did the outcome we are about to act on actually match the conflict condition?
 *
 * Reading the typed delta, rather than the outcome's reason text, keeps every other delivery out by
 * construction instead of by a list of exceptions: an expiry, a HEAD change, a CI verdict, a comment
 * and a cancel all fail this test without being named. Absent deltas fail it too — auto-resolution
 * writes to a repository, so it needs proof, not the absence of a denial.
 */
function conflictWasMatched(outcome: WaitOutcomeV1 | undefined): boolean {
  return outcome?.matched?.some((delta) => delta.kind === 'pr_became_conflicting') === true;
}

async function tryAutoResolveBeforeWake(
  opts: ConflictCheckTaskSpecOptions,
  workItem: ConflictWorkItem,
  outcome: WaitOutcomeV1 | undefined,
  signal?: AbortSignal,
): Promise<AutoResolveResult | null> {
  if (!opts.autoExecutor || workItem.signal.mergeState !== 'CONFLICTING' || signal?.aborted) return null;
  // A conflicting repository state is not a mandate: the owner's wait has to be the thing that matched.
  if (!conflictWasMatched(outcome)) return null;
  try {
    return await opts.autoExecutor.resolve(workItem.signal.repoFullName, workItem.signal.prNumber, signal);
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
        // #320: Read from unified TaskStore — exclude done tasks (PR merged/closed)
        const tasks = (await opts.taskStore.listByKind('pr_tracking')).filter((t) => t.status !== 'done');
        if (tasks.length === 0) {
          return { run: false, reason: 'no tracked PRs' };
        }

        const workItems: { signal: ConflictWorkItem; subjectKey: string }[] = [];
        for (const task of tasks) {
          try {
            const parsed = task.subjectKey ? parsePrSubjectKey(task.subjectKey) : null;
            if (!parsed) continue;
            const { repoFullName, prNumber } = parsed;

            const { mergeState, headSha } = await opts.checkMergeable(repoFullName, prNumber);
            workItems.push({
              signal: {
                signal: { repoFullName, prNumber, headSha, mergeState },
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
        const routeResult = await opts.conflictRouter.route(workItem.signal);
        if (routeResult.kind !== 'notified') return;
        const conflictDelivery = conflictWasMatched(routeResult.outcome);

        // F140 Phase C: try auto-resolve before waking cat — only for a conflict the wait matched.
        const result = await tryAutoResolveBeforeWake(opts, workItem, routeResult.outcome, ctx.signal);
        if (result?.kind === 'resolved') {
          opts.log.info(`[conflict-check] Auto-resolved conflict for ${result.branch} (${result.method})`);
          return;
        }
        if (result?.kind === 'escalated') {
          opts.log.info(`[conflict-check] Escalating: ${result.files.length} conflict file(s) in ${result.branch}`);
        }

        if (opts.invokeTrigger) {
          /*
           * #1392 R5: this poller delivers whatever the wait produced, so only a matched conflict may
           * be labelled and prioritised as one. Anything else — an expiry above all — is an ordinary
           * wait delivery, and calling it a conflict would misfile it for the owner reading the wake.
           */
          const policy: ConnectorTriggerPolicy = conflictDelivery
            ? { priority: 'urgent', reason: 'github_pr_conflict', sourceCategory: 'conflict' }
            : { priority: 'normal', reason: 'github_wait_satisfied', sourceCategory: 'scheduled' };
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
          opts.log.info(`[conflict-check] Triggered ${routeResult.catId} for ${policy.reason}`);
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
