/**
 * F139 + clowder-ai#320: CiCdCheckTaskSpec — wraps CiCdCheckPoller.pollOne as a TaskSpec_P1.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → filter active → one workItem per PR.
 * Execute: fetchPrStatus → route → optional trigger (same logic as pollOne).
 */
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { CiCdRouter, CiPollResult } from './CiCdRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import { fetchPrCiStatus } from './ci-status-fetcher.js';

/** Signal carries the TaskItem so execute can access threadId/catId/userId */
export interface CiCdCheckSignal {
  task: TaskItem;
  repoFullName: string;
  prNumber: number;
}

export interface CiCdCheckTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly cicdRouter: CiCdRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly fetchPrStatus?: (repoFullName: string, prNumber: number) => Promise<CiPollResult | null>;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
}

export function createCiCdCheckTaskSpec(opts: CiCdCheckTaskSpecOptions): TaskSpec_P1<CiCdCheckSignal> {
  const fetchPrStatus = opts.fetchPrStatus ?? ((repo: string, pr: number) => fetchPrCiStatus(repo, pr, opts.log));

  return {
    id: 'cicd-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        // #320: Read from unified TaskStore — exclude done tasks (PR merged/closed)
        const allTasks = await opts.taskStore.listByKind('pr_tracking');
        const active = allTasks.filter((t) => t.status !== 'done' && t.automationState?.ci?.enabled !== false);

        if (active.length === 0) {
          return { run: false, reason: 'no active tracked PRs' };
        }

        const workItems: { signal: CiCdCheckSignal; subjectKey: string }[] = [];
        for (const task of active) {
          const parsed = task.subjectKey ? parsePrSubjectKey(task.subjectKey) : null;
          if (!parsed) continue;
          workItems.push({
            signal: { task, repoFullName: parsed.repoFullName, prNumber: parsed.prNumber },
            subjectKey: task.subjectKey!,
          });
        }

        if (workItems.length === 0) {
          return { run: false, reason: 'no parseable PR tasks' };
        }

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(signal: CiCdCheckSignal, _subjectKey: string, _ctx: ExecuteContext) {
        const pollResult = await fetchPrStatus(signal.repoFullName, signal.prNumber);
        if (!pollResult) return;

        const routeResult = await opts.cicdRouter.route(pollResult);

        if (routeResult.kind === 'notified' && opts.invokeTrigger) {
          const isFail = routeResult.bucket === 'fail';
          const policy: ConnectorTriggerPolicy = {
            priority: isFail ? 'urgent' : 'normal',
            reason: isFail ? 'github_ci_failure' : 'github_ci_pass',
            suggestedSkill: isFail ? undefined : 'merge-gate',
          };
          opts.invokeTrigger.trigger(
            routeResult.threadId,
            routeResult.catId as CatId,
            signal.task.userId ?? '',
            routeResult.content,
            routeResult.messageId,
            undefined,
            policy,
          );
          opts.log.info(`[cicd-check] Triggered ${routeResult.catId} for CI ${isFail ? 'failure' : 'pass'}`);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: 'CI/CD 检查',
      category: 'pr',
      description: '监控 tracked PR 的 CI 状态变化',
      subjectKind: 'pr',
    },
  };
}
