/**
 * F139 + F140 + clowder-ai#320: ConflictCheckTaskSpec — detect PR merge conflicts via injectable check.
 *
 * #320: Reads from unified TaskStore (kind=pr_tracking) instead of PrTrackingStore.
 *
 * Gate: list pr_tracking tasks → checkMergeable per PR → build ConflictSignals.
 * Execute: the router terminalizes the matched outcome but holds its announcement, the executor
 * gets its chance to repair, and only an unrepaired conflict is published — one admission, one wake.
 *
 * KD-9: Gate passes ALL mergeState results (including MERGEABLE) so ConflictRouter
 *       can clear fingerprints for re-conflict detection.
 */
import type { TaskItem, WaitOutcomeV1 } from '@cat-cafe/shared';
import { parsePrSubjectKey } from '@cat-cafe/shared';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext, TaskSpec_P1 } from '../scheduler/types.js';
import type { AutoResolveResult, ConflictAutoExecutor } from './ConflictAutoExecutor.js';
import type { ConflictRouter, ConflictSignal } from './ConflictRouter.js';

export interface ConflictCheckTaskSpecOptions {
  readonly taskStore: ITaskStore;
  readonly checkMergeable: (repoFullName: string, prNumber: number) => Promise<{ mergeState: string; headSha: string }>;
  readonly conflictRouter: ConflictRouter;
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
 * #1392 R5: may this outcome authorise a repository write?
 *
 * Two independent facts have to hold, and neither implies the other.
 *
 * The reason must positively be `matched`. An expired wait keeps its last poll's deltas so the owner
 * still sees the facts it ended on — that record is a report, not a renewed mandate, because the
 * wait's authority ended with the wait. A conflict seen only after the deadline may be told; it may
 * not be acted on, and the delta is never dropped to make that true.
 *
 * And the conflict must be inside that match. A delivery about HEAD, CI, a comment or a cancel is
 * not a conflict just because the repository happens to be conflicting right now.
 *
 * Both are machine-checked enum fields rather than parsed prose, and both are positive tests: an
 * absent outcome fails them, because writing to a repository needs proof, not the absence of denial.
 */
function conflictWasMatched(outcome: WaitOutcomeV1 | undefined): boolean {
  if (outcome?.reason !== 'matched') return false;
  return outcome.matched?.some((delta) => delta.kind === 'pr_became_conflicting') === true;
}

async function tryAutoResolve(
  opts: ConflictCheckTaskSpecOptions,
  workItem: ConflictWorkItem,
  outcome: WaitOutcomeV1 | undefined,
  signal?: AbortSignal,
): Promise<AutoResolveResult | null> {
  if (!opts.autoExecutor || workItem.signal.mergeState !== 'CONFLICTING' || signal?.aborted) return null;
  // A conflicting repository state is not a mandate: a live wait of the owner's has to be what matched.
  if (!conflictWasMatched(outcome)) return null;
  try {
    return await opts.autoExecutor.resolve(workItem.signal.repoFullName, workItem.signal.prNumber, signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    opts.log.warn({ error }, '[conflict-check] cancellation interrupted optional auto-resolution');
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
        // An outcome that was already announced, or that never matched, is not ours to decide about.
        if (routeResult.kind !== 'matched_pending') return;

        // Phase C AC-C1. The owner asked to be told their PR conflicts; they should not be told
        // about a conflict that no longer exists by the time anyone could read it. #1392 R5 is what
        // makes the ordering legal: the authorization to touch the repository is the terminalized
        // matched outcome, which is durable here even though nothing has been announced. Repair
        // first, then decide whether there is anything left to say.
        const result = await tryAutoResolve(opts, workItem, routeResult.outcome, ctx.signal);
        if (result?.kind === 'resolved') {
          const settled = await opts.conflictRouter.settleWithoutWake(
            routeResult.taskId,
            routeResult.outcome,
            `auto-resolved:${result.method}`,
          );
          opts.log.info(
            `[conflict-check] Auto-resolved conflict for ${result.branch} (${result.method})${
              settled ? '' : ' — the outbox had already flushed, so the owner was told anyway'
            }`,
          );
          return;
        }
        if (result?.kind === 'escalated') {
          opts.log.info(`[conflict-check] Escalating: ${result.files.length} conflict file(s) in ${result.branch}`);
        }
        // Everything that is not a completed repair reaches the owner: escalations, refusals,
        // executor absence, and a cancelled attempt alike. Publishing is compare-and-set on this
        // exact outcome, so a concurrent outbox flush cannot turn into a second wake.
        await opts.conflictRouter.publish(routeResult.taskId, routeResult.outcome);
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
