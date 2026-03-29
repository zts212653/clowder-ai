/**
 * F139: CiCdCheckTaskSpec — wraps CiCdCheckPoller.pollOne as a TaskSpec_P1.
 *
 * Gate: list tracked PRs → filter active → one workItem per PR.
 * Execute: fetchPrStatus → route → optional trigger (same logic as pollOne).
 */
import type { CatId } from '@cat-cafe/shared';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import { CiCdCheckPoller } from './CiCdCheckPoller.js';
import type { CiCdRouter, CiPollResult } from './CiCdRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IPrTrackingStore, PrTrackingEntry } from './PrTrackingStore.js';

export interface CiCdCheckTaskSpecOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly cicdRouter: CiCdRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  /** Injectable for testing — defaults to CiCdCheckPoller.fetchPrStatus */
  readonly fetchPrStatus?: (repoFullName: string, prNumber: number) => Promise<CiPollResult | null>;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
}

export function createCiCdCheckTaskSpec(opts: CiCdCheckTaskSpecOptions): TaskSpec_P1<PrTrackingEntry> {
  // Reuse fetchPrStatus from CiCdCheckPoller (public method) unless overridden
  const poller = new CiCdCheckPoller({
    prTrackingStore: opts.prTrackingStore,
    cicdRouter: opts.cicdRouter,
    invokeTrigger: opts.invokeTrigger,
    log: opts.log as never,
    pollIntervalMs: opts.pollIntervalMs,
  });
  const fetchPrStatus = opts.fetchPrStatus ?? poller.fetchPrStatus.bind(poller);

  return {
    id: 'cicd-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate() {
        const entries = await opts.prTrackingStore.listAll();
        const active = entries.filter((e: PrTrackingEntry) => e.ciTrackingEnabled !== false);

        if (active.length === 0) {
          return { run: false, reason: 'no active tracked PRs' };
        }

        return {
          run: true,
          workItems: active.map((entry: PrTrackingEntry) => ({
            signal: entry,
            subjectKey: `pr-${entry.repoFullName}#${entry.prNumber}`,
          })),
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(entry: PrTrackingEntry, _subjectKey: string, _ctx: ExecuteContext) {
        // Replicate pollOne logic: fetch → route → optional trigger
        const pollResult = await fetchPrStatus(entry.repoFullName, entry.prNumber);
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
            entry.userId,
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
