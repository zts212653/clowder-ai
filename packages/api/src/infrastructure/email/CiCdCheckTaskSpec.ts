/**
 * F139 + clowder-ai#320: CiCdCheckTaskSpec — poll tracked PRs' CI status as a TaskSpec_P1.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → filter active → one workItem per PR.
 * Execute: fetchPrCiStatus → route → conditional trigger.
 *   - CI fail → wake (urgent) — both intents.
 *   - CI pass → gated by the tracked PR's wake intent (F140):
 *       intent='review' (default) → state-only silent (review-wait noise; no connector message).
 *       intent='merge'            → wake → merge-gate (the cat is waiting on CI-green to merge).
 *     Intent is an explicit per-task declaration (set at register_pr_tracking, updated by re-register),
 *     NOT inferred from approval state or repo type — a private PR can be 'merge', an open-source PR
 *     can be 'review'.
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
  /** F167 Phase Q: retire matching hold_ball timers once structured CI status is delivered. */
  readonly holdLifecycle?: {
    retireSatisfiedWait(event: {
      threadId: string;
      subjectKey: string;
      expectedSignalKey: 'ci_complete';
      sourceKind: 'ci_check';
      sourceMessageId?: string;
    }): void | Promise<unknown>;
  };
}

/**
 * PR terminal state (merged/closed) -> wake the owner for follow-up, both intents.
 * intent=merge: the merge is the awaited outcome. intent=review: the PR is gone.
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
  return (
    task.status === 'done' &&
    (reviewTerminalState === 'merged' || reviewTerminalState === 'closed') &&
    !task.automationState?.ci?.prState
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
      async execute(signal: CiCdCheckSignal, subjectKey: string, _ctx: ExecuteContext) {
        const pollResult = await fetchPrStatus(signal.repoFullName, signal.prNumber);
        if (!pollResult) return;

        const routeResult = await opts.cicdRouter.route(pollResult);
        if (!opts.invokeTrigger) return;

        const retireSatisfiedCiHold = async (threadId: string, sourceMessageId: string) => {
          if (!opts.holdLifecycle) return;
          try {
            await opts.holdLifecycle.retireSatisfiedWait({
              threadId,
              subjectKey,
              expectedSignalKey: 'ci_complete',
              sourceKind: 'ci_check',
              sourceMessageId,
            });
          } catch (err) {
            opts.log.warn({ err, subjectKey }, '[cicd-check] hold lifecycle retirement failed (best-effort)');
          }
        };

        if (routeResult.kind === 'lifecycle') {
          await retireSatisfiedCiHold(routeResult.threadId, routeResult.messageId);
          triggerLifecycleWake(opts, opts.invokeTrigger, signal, routeResult);
          return;
        }

        if (routeResult.kind !== 'notified') return;

        // CI fail → always wake (urgent, must fix) — independent of intent.
        if (routeResult.bucket === 'fail') {
          await retireSatisfiedCiHold(routeResult.threadId, routeResult.messageId);
          const policy: ConnectorTriggerPolicy = {
            priority: 'urgent',
            reason: 'github_ci_failure',
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
            .catch((err) => opts.log.warn({ err }, '[cicd-check] trigger failed (best-effort)'));
          opts.log.info(`[cicd-check] Triggered ${routeResult.catId} for CI failure`);
          return;
        }

        // CI pass → gated by the tracked PR's wake intent (F140 Phase C partial revert).
        // 'review' (default): the cat is waiting on review feedback → CI-pass is noise.
        //   CiCdRouter should record state without posting a connector message, so stay silent.
        // 'merge': the cat is waiting on CI-green to merge → CI-pass is the action signal → merge-gate.
        const intent = signal.task.automationState?.intent ?? 'review';
        if (intent !== 'merge') {
          opts.log.info(`[cicd-check] CI pass for ${routeResult.catId} — silent (intent=${intent}; state-only)`);
          return;
        }

        await retireSatisfiedCiHold(routeResult.threadId, routeResult.messageId);
        const policy: ConnectorTriggerPolicy = {
          priority: 'normal',
          reason: 'github_ci_pass',
          sourceCategory: 'ci',
          suggestedSkill: 'merge-gate',
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
          .catch((err) => opts.log.warn({ err }, '[cicd-check] merge-gate trigger failed (best-effort)'));
        opts.log.info(`[cicd-check] CI pass → wake ${routeResult.catId} (intent=merge → merge-gate)`);
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
