/**
 * F139 + clowder-ai#320: CiCdCheckTaskSpec — poll tracked PRs' CI status as a TaskSpec_P1.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → filter active → one workItem per PR.
 * Execute: fetch current PR/CI facts → route through F280 typed wait predicates.
 * Collection always advances; only a matched generation creates a connector wake.
 */
import type { TaskItem } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, GateCtx, TaskSpec_P1 } from '../scheduler/types.js';
import type { CiCdRouter, CiPollResult, CiRouteResult } from './CiCdRouter.js';
import { isStaleCiSnapshot } from './ci-cd-contract.js';
import { ciStatusTargetKey, createCiCollectionReaders, type PrCiStatusTarget } from './ci-status-batch-fetcher.js';
import { enrichPrCiFailure } from './ci-status-fetcher.js';

/** Signal carries the TaskItem so execute can access threadId/catId/userId */
export interface CiCdCheckSignal {
  task: TaskItem;
  repoFullName: string;
  prNumber: number;
  /** Tick-level batch snapshot; production reads it once in admission.gate. */
  pollResult?: CiPollResult | null;
}

export interface CiCdCheckTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly cicdRouter: CiCdRouter;
  readonly fetchPrStatus?: (
    repoFullName: string,
    prNumber: number,
    signal?: AbortSignal,
  ) => Promise<CiPollResult | null>;
  /** F304 test seam for the production one-process-per-tick GraphQL reader. */
  readonly fetchPrStatuses?: (
    targets: readonly PrCiStatusTarget[],
    signal?: AbortSignal,
    gateCtx?: GateCtx,
  ) => Promise<ReadonlyMap<string, CiPollResult | null>>;
  readonly enrichFailureDetails?: (poll: CiPollResult, signal: AbortSignal) => Promise<CiPollResult>;
  readonly log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  /**
   * F168 external-case collection outlives one F280 wait generation. A done
   * wait remains collectable only when the canonical external-review policy
   * says this PR still has an open maintainer-review lifecycle.
   */
  readonly continueDoneTracking?: (repoFullName: string, prNumber: number) => Promise<boolean>;
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  readonly id?: string;
  /**
   * Filter self-merges: if the GitHub login that merged the PR matches our own
   * authenticated identity, skip the lifecycle wake (the merger already knows).
   * Reuses the same self-login resolver as review feedback echo filtering.
   */
  readonly isSelfMerge?: (mergedByLogin: string) => boolean;
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

async function shouldCollectTask(
  opts: CiCdCheckTaskSpecOptions,
  task: TaskItem,
  repoFullName: string,
  prNumber: number,
  subjectKey: string,
): Promise<boolean> {
  if (task.automationState?.ci?.enabled === false) return false;
  if (task.status !== 'done' || needsCiLifecycleRecovery(task)) return true;
  const ci = task.automationState?.ci;
  if ((ci?.prState === 'merged' || ci?.prState === 'closed') && ci.terminalEffects?.completedAt !== undefined)
    return false;
  if (!opts.continueDoneTracking) return false;
  try {
    return await opts.continueDoneTracking(repoFullName, prNumber);
  } catch (error) {
    opts.log.warn({ error, subjectKey }, '[F168] external-review CI continuation check failed; deferring collection');
    return false;
  }
}

async function listCollectablePrs(opts: CiCdCheckTaskSpecOptions, signal?: AbortSignal) {
  const candidates: { signal: CiCdCheckSignal; subjectKey: string }[] = [];
  for (const task of await opts.taskStore.listByKind('pr_tracking')) {
    signal?.throwIfAborted();
    if (!task.subjectKey) continue;
    const parsed = parsePrSubjectKey(task.subjectKey);
    if (!parsed || !(await shouldCollectTask(opts, task, parsed.repoFullName, parsed.prNumber, task.subjectKey)))
      continue;
    candidates.push({ signal: { task, ...parsed }, subjectKey: task.subjectKey });
  }
  return candidates;
}

async function resolvePollResult(opts: CiCdCheckTaskSpecOptions, item: CiCdCheckSignal, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const poll = opts.fetchPrStatus
    ? await opts.fetchPrStatus(item.repoFullName, item.prNumber, signal)
    : item.pollResult;
  signal?.throwIfAborted();
  if (!poll) throw new Error(`CI collection unavailable for ${item.repoFullName}#${item.prNumber}; retry next poll`);
  const currentWait = (await opts.taskStore.get(item.task.id))?.automationState?.await;
  if (isStaleCiSnapshot(poll, currentWait)) {
    throw new Error(`Stale CI snapshot for ${item.repoFullName}#${item.prNumber}; retry current HEAD`);
  }
  if (!poll.failureDetailsPending && !poll.fullRollupPending) return poll;
  // Admission is one batched request; details can need several typed GitHub
  // reads. Keep their combined budget below the existing 30-second work item.
  const timeoutSignal = AbortSignal.timeout(20_000);
  const detailSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const result = opts.enrichFailureDetails
    ? await opts.enrichFailureDetails(poll, detailSignal)
    : await enrichPrCiFailure(poll, opts.log, { signal: detailSignal, timeoutMs: 5_000 });
  detailSignal.throwIfAborted();
  const afterDetails = (await opts.taskStore.get(item.task.id))?.automationState?.await;
  if (isStaleCiSnapshot(result, afterDetails)) {
    throw new Error(`Stale CI snapshot for ${item.repoFullName}#${item.prNumber}; retry current HEAD`);
  }
  return result;
}

function isUnrecordedCiRoute(result: CiRouteResult): result is Extract<CiRouteResult, { kind: 'deduped' }> {
  return (
    result.kind === 'deduped' &&
    (result.reason === 'stale_source_observation' || result.reason === 'generation_changed_concurrently')
  );
}

/** Number of circular windows before their starting position repeats. */
function collectionCycleLength(candidateCount: number, windowSize: number): number {
  let a = candidateCount;
  let b = windowSize;
  while (b !== 0) [a, b] = [b, a % b];
  return candidateCount / a;
}

export function createCiCdCheckTaskSpec(opts: CiCdCheckTaskSpecOptions): TaskSpec_P1<CiCdCheckSignal> {
  const defaultReaders = createCiCollectionReaders(opts.log, () => undefined);
  const fetchPrStatuses = opts.fetchPrStatuses ?? defaultReaders.fetchPrStatuses;
  let lastCollectedSubject: string | undefined;
  let firstBatchOffset = 0;
  let ticksInCollectionCycle = 0;

  return {
    id: opts.id ?? 'cicd-check',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate(ctx) {
        const gateSignal = ctx?.signal;
        gateSignal?.throwIfAborted();
        // #320: Read from unified TaskStore — exclude done tasks after CI lifecycle is complete.
        // Review feedback can observe terminal PR state first; keep those done tasks
        // reachable until CiCdRouter delivers/records the CI lifecycle marker.
        const candidates = await listCollectablePrs(opts, gateSignal);

        gateSignal?.throwIfAborted();
        if (candidates.length === 0) {
          return { run: false, reason: 'no parseable PR tasks' };
        }

        // At most three 20-PR requests share admission's whole-gate deadline;
        // each reader also bounds its queue+I/O wait. Rotate window membership
        // and batch position separately: a repeated cohort must not keep the
        // same subjects in the failed first batch. Advance both before I/O.
        const start =
          (candidates.findIndex((item) => item.subjectKey === lastCollectedSubject) + 1) % candidates.length;
        const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 60);
        lastCollectedSubject = selected.at(-1)?.subjectKey;
        const offset = firstBatchOffset % selected.length;
        const workItems = [...selected.slice(offset), ...selected.slice(0, offset)];
        // Rotate after the window-start cycle, rather than every tick: otherwise
        // cohort and batch cycles can align again (e.g. three 60-PR cohorts).
        if (++ticksInCollectionCycle >= collectionCycleLength(candidates.length, selected.length)) {
          ticksInCollectionCycle = 0;
          firstBatchOffset = (offset + 20) % selected.length;
        }

        if (!opts.fetchPrStatus) {
          // This is one tick-level read, not work owned by the first item. Per-item
          // timeout signals must never cancel facts consumed by sibling work items.
          const targets = workItems.map(({ signal }) => ({
            repoFullName: signal.repoFullName,
            prNumber: signal.prNumber,
          }));
          const results = await fetchPrStatuses(targets, gateSignal, ctx);
          gateSignal?.throwIfAborted();
          for (const workItem of workItems) {
            workItem.signal.pollResult =
              results.get(ciStatusTargetKey(workItem.signal.repoFullName, workItem.signal.prNumber)) ?? null;
          }
        }

        gateSignal?.throwIfAborted();
        // Route available facts before attempting slow failure-detail reads.
        workItems.sort(
          (a, b) =>
            Number(
              a.signal.pollResult?.failureDetailsPending === true || a.signal.pollResult?.fullRollupPending === true,
            ) -
            Number(
              b.signal.pollResult?.failureDetailsPending === true || b.signal.pollResult?.fullRollupPending === true,
            ),
        );
        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(signal: CiCdCheckSignal, _subjectKey: string, ctx: ExecuteContext) {
        const pollResult = await resolvePollResult(opts, signal, ctx.signal);

        const routeResult = await opts.cicdRouter.route(pollResult);
        if (isUnrecordedCiRoute(routeResult)) {
          const failure =
            routeResult.reason === 'stale_source_observation' ? 'Stale CI snapshot' : 'Unrecorded CI observation';
          throw new Error(
            `${failure} for ${signal.repoFullName}#${signal.prNumber}: ${routeResult.reason}; retry next poll`,
          );
        }

        if (routeResult.kind === 'lifecycle') {
          // Skip wake when the merge was performed by our own GitHub identity —
          // the merger already knows the PR state; waking them wastes tokens.
          // Message delivery already happened inside CiCdRouter.closeLifecycle.
          if (pollResult.mergedByLogin && opts.isSelfMerge?.(pollResult.mergedByLogin)) {
            opts.log.info(`[cicd-check] PR ${routeResult.prState} by self (${pollResult.mergedByLogin}) -> skip wake`);
            return;
          }
          // CiCdRouter already admitted this terminal notice in one transaction; Queue drain owes
          // the wake. No second trigger to fire twice or to drop best-effort.
          opts.log.info(`[cicd-check] PR ${routeResult.prState} -> ${routeResult.catId} (terminal lifecycle)`);
          return;
        }

        if (routeResult.kind !== 'notified') return;

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
