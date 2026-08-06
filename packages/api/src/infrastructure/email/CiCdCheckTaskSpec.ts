/**
 * F139 + clowder-ai#320: CiCdCheckTaskSpec — poll tracked PRs' CI status as a TaskSpec_P1.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → filter active → one workItem per PR.
 * Execute: fetch current PR/CI facts → route through F280 typed wait predicates.
 * Collection always advances; only a matched generation creates a connector wake.
 */
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { CiCdRouter, CiPollResult, CiRouteResult } from './CiCdRouter.js';
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
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  readonly id?: string;
  /**
   * Filter self-merges: if the GitHub login that merged the PR matches our own
   * authenticated identity, skip the lifecycle wake (the merger already knows).
   * Reuses the same self-login resolver as review feedback echo filtering.
   */
  readonly isSelfMerge?: (mergedByLogin: string) => boolean;
}

/**
 * PR terminal state (merged/closed) consumes any active wait exactly once.
 * Fires exactly once in production: CiCdRouter persists ci.prState and the gate filters completed lifecycle tasks.
 */
function triggerLifecycleWake(
  opts: CiCdCheckTaskSpecOptions,
  invokeTrigger: ConnectorInvokeTrigger,
  signal: CiCdCheckSignal,
  routeResult: Extract<CiRouteResult, { kind: 'lifecycle' }>,
): void {
  const policy: ConnectorTriggerPolicy = {
    priority: 'normal',
    reason: routeResult.prState === 'merged' ? 'github_pr_merged' : 'github_pr_closed',
    sourceCategory: 'ci',
  };
  void invokeTrigger
    .trigger(
      routeResult.threadId,
      routeResult.catId as CatId,
      signal.task.userId ?? '',
      routeResult.content,
      routeResult.messageId,
      undefined,
      policy,
    )
    .catch((err) => opts.log.warn({ err }, '[cicd-check] lifecycle trigger failed (best-effort)'));
  opts.log.info(`[cicd-check] PR ${routeResult.prState} -> wake ${routeResult.catId} (terminal lifecycle)`);
}

function needsCiLifecycleRecovery(task: TaskItem): boolean {
  const reviewTerminalState = task.automationState?.review?.prState;
  const ciTerminalState = task.automationState?.ci?.prState;
  const terminalEffects = task.automationState?.ci?.terminalEffects;
  const worldTruthPending =
    (ciTerminalState === 'merged' || ciTerminalState === 'closed') &&
    (terminalEffects?.prState !== ciTerminalState || terminalEffects.completedAt === undefined);
  return (
    task.status === 'done' &&
    (worldTruthPending || ((reviewTerminalState === 'merged' || reviewTerminalState === 'closed') && !ciTerminalState))
  );
}

export function createCiCdCheckTaskSpec(opts: CiCdCheckTaskSpecOptions): TaskSpec_P1<CiCdCheckSignal> {
  const fetchPrStatus = opts.fetchPrStatus ?? ((repo: string, pr: number) => fetchPrCiStatus(repo, pr, opts.log));

  return {
    id: opts.id ?? 'cicd-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        // #320: Read from unified TaskStore — exclude done tasks after CI lifecycle is complete.
        // Review feedback can observe terminal PR state first; keep those done tasks
        // reachable until CiCdRouter delivers/records the CI lifecycle marker.
        const allTasks = await opts.taskStore.listByKind('pr_tracking');
        const active = allTasks.filter(
          (t) => (t.status !== 'done' || needsCiLifecycleRecovery(t)) && t.automationState?.ci?.enabled !== false,
        );

        if (active.length === 0) {
          return { run: false, reason: 'no active tracked PRs' };
        }

        const workItems: { signal: CiCdCheckSignal; subjectKey: string }[] = [];
        for (const task of active) {
          const subjectKey = task.subjectKey;
          if (!subjectKey) continue;
          const parsed = parsePrSubjectKey(subjectKey);
          if (!parsed) continue;
          workItems.push({
            signal: { task, repoFullName: parsed.repoFullName, prNumber: parsed.prNumber },
            subjectKey,
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
        if (!opts.invokeTrigger) return;

        if (routeResult.kind === 'lifecycle') {
          // Skip wake when the merge was performed by our own GitHub identity —
          // the merger already knows the PR state; waking them wastes tokens.
          // Message delivery already happened inside CiCdRouter.closeLifecycle.
          if (pollResult.mergedByLogin && opts.isSelfMerge?.(pollResult.mergedByLogin)) {
            opts.log.info(`[cicd-check] PR ${routeResult.prState} by self (${pollResult.mergedByLogin}) -> skip wake`);
            return;
          }
          triggerLifecycleWake(opts, opts.invokeTrigger, signal, routeResult);
          return;
        }

        if (routeResult.kind !== 'notified') return;

        const policy: ConnectorTriggerPolicy = {
          priority: routeResult.bucket === 'fail' ? 'urgent' : 'normal',
          reason: 'github_wait_satisfied',
          sourceCategory: 'ci',
        };
        void opts.invokeTrigger
          .trigger(
            routeResult.threadId,
            routeResult.catId as CatId,
            signal.task.userId ?? '',
            routeResult.content,
            routeResult.messageId,
            undefined,
            policy,
          )
          .catch((err) => opts.log.warn({ err }, '[cicd-check] wait trigger failed (best-effort)'));
        opts.log.info(`[cicd-check] Typed wait satisfied → wake ${routeResult.catId}`);
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
