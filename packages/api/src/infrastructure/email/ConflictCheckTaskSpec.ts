/**
 * F139/F140: ConflictCheckTaskSpec — detect PR merge conflicts via injectable check.
 *
 * Gate: list tracked PRs → checkMergeable per PR → build ConflictSignals.
 * Execute: ConflictRouter handles dedup/delivery → ConnectorInvokeTrigger wakes cat.
 *
 * KD-9: Gate passes ALL mergeState results (including MERGEABLE) so ConflictRouter
 *       can clear fingerprints for re-conflict detection.
 */
import type { CatId } from '@cat-cafe/shared';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { ConflictRouter, ConflictSignal } from './ConflictRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IPrTrackingStore } from './PrTrackingStore.js';

export interface ConflictCheckTaskSpecOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly checkMergeable: (repoFullName: string, prNumber: number) => Promise<{ mergeState: string; headSha: string }>;
  readonly conflictRouter: ConflictRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
}

interface ConflictWorkItem {
  signal: ConflictSignal;
  entry: { userId: string };
}

export function createConflictCheckTaskSpec(opts: ConflictCheckTaskSpecOptions): TaskSpec_P1<ConflictWorkItem> {
  return {
    id: 'conflict-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 5 * 60 * 1000 },
    admission: {
      async gate() {
        const entries = await opts.prTrackingStore.listAll();
        if (entries.length === 0) {
          return { run: false, reason: 'no tracked PRs' };
        }

        const workItems: { signal: ConflictWorkItem; subjectKey: string }[] = [];
        for (const entry of entries) {
          try {
            const { mergeState, headSha } = await opts.checkMergeable(entry.repoFullName, entry.prNumber);
            workItems.push({
              signal: {
                signal: {
                  repoFullName: entry.repoFullName,
                  prNumber: entry.prNumber,
                  headSha,
                  mergeState,
                },
                entry: { userId: entry.userId },
              },
              subjectKey: `pr-${entry.repoFullName}#${entry.prNumber}`,
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

        if (routeResult.kind === 'notified' && opts.invokeTrigger) {
          const policy: ConnectorTriggerPolicy = { priority: 'urgent', reason: 'github_pr_conflict' };
          opts.invokeTrigger.trigger(
            routeResult.threadId,
            routeResult.catId as CatId,
            workItem.entry.userId,
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
  };
}
