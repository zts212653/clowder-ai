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
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConflictAutoExecutor } from './ConflictAutoExecutor.js';
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
}

interface ConflictWorkItem {
  signal: ConflictSignal;
  task: TaskItem;
}

export function createConflictCheckTaskSpec(opts: ConflictCheckTaskSpecOptions): TaskSpec_P1<ConflictWorkItem> {
  return {
    id: 'conflict-check',
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
          } catch {
            // fail-open: skip PRs where check fails
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
      async execute(workItem: ConflictWorkItem, _subjectKey: string, _ctx: ExecuteContext) {
        const routeResult = await opts.conflictRouter.route(workItem.signal);
        if (routeResult.kind !== 'notified') return;

        // F140 Phase C: try auto-resolve before waking cat
        if (opts.autoExecutor && workItem.signal.mergeState === 'CONFLICTING') {
          const result = await opts.autoExecutor.resolve(workItem.signal.repoFullName, workItem.signal.prNumber);
          if (result.kind === 'resolved') {
            opts.log.info(`[conflict-check] Auto-resolved conflict for ${result.branch} (${result.method})`);
            return;
          }
          if (result.kind === 'escalated') {
            opts.log.info(`[conflict-check] Escalating: ${result.files.length} conflict file(s) in ${result.branch}`);
          }
        }

        if (opts.invokeTrigger) {
          const policy: ConnectorTriggerPolicy = { priority: 'urgent', reason: 'github_pr_conflict' };
          opts.invokeTrigger.trigger(
            routeResult.threadId,
            routeResult.catId as CatId,
            workItem.task.userId ?? '',
            routeResult.content,
            routeResult.messageId,
            undefined,
            policy,
          );
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
