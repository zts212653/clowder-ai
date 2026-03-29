import type { EmissionStore } from './EmissionStore.js';
import type { GlobalControlStore } from './GlobalControlStore.js';
import type { RunLedger } from './RunLedger.js';
import type {
  ActorRole,
  CostTier,
  DeliverOpts,
  FetchResult,
  GateCtx,
  RunOutcome,
  ScheduleInvokeTrigger,
  TaskSpec_P1,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTaskSpec = TaskSpec_P1<any>;

export interface PipelineContext {
  task: AnyTaskSpec;
  ledger: RunLedger;
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  running: Map<string, boolean>;
  tickCounts: Map<string, number>;
  lastRunAt: Map<string, number | null>;
  actorResolver?: (role: ActorRole, costTier: CostTier) => string | null;
  /** Phase 3B (AC-D1): governance store — optional for backwards compat */
  globalControlStore?: GlobalControlStore;
  /** Phase 3B (AC-D2): emission store for self-echo suppression */
  emissionStore?: EmissionStore;
  /** Phase 3B (AC-D1): manual triggers bypass global pause + task overrides */
  isManualTrigger?: boolean;
  /** Phase 4 (AC-H1): deliver message to a thread */
  deliver?: (opts: DeliverOpts) => Promise<string>;
  /** Phase 4 (AC-H2): fetch web content with browser-automation routing */
  fetchContent?: (url: string) => Promise<FetchResult>;
  /** Phase 4b: invoke a cat to handle a scheduled task (fire-and-forget) */
  invokeTrigger?: ScheduleInvokeTrigger;
}

function withTimeout(promise: Promise<void>, ms: number, taskId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[scheduler] ${taskId}: execute timed out after ${ms}ms`));
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function executeTaskPipeline(ctx: PipelineContext): Promise<void> {
  const {
    task,
    ledger,
    logger,
    running,
    tickCounts,
    lastRunAt,
    actorResolver,
    globalControlStore,
    emissionStore,
    isManualTrigger,
    deliver,
    fetchContent,
    invokeTrigger,
  } = ctx;
  const startMs = Date.now();
  const tickCount = (tickCounts.get(task.id) ?? 0) + 1;
  tickCounts.set(task.id, tickCount);

  // Step 1: Enabled check
  if (!task.enabled()) return;

  // Step 1b: Governance checks (AC-D1) — skipped for manual triggers
  if (globalControlStore && !isManualTrigger) {
    if (!globalControlStore.getGlobalEnabled()) {
      ledger.record({
        task_id: task.id,
        subject_key: task.id,
        outcome: 'SKIP_GLOBAL_PAUSE',
        signal_summary: null,
        duration_ms: Date.now() - startMs,
        started_at: new Date(startMs).toISOString(),
        assigned_cat_id: null,
        error_summary: null,
      });
      return;
    }
    const taskOverride = globalControlStore.getTaskOverride(task.id);
    if (taskOverride && !taskOverride.enabled) {
      ledger.record({
        task_id: task.id,
        subject_key: task.id,
        outcome: 'SKIP_TASK_OVERRIDE',
        signal_summary: null,
        duration_ms: Date.now() - startMs,
        started_at: new Date(startMs).toISOString(),
        assigned_cat_id: null,
        error_summary: null,
      });
      return;
    }
  }

  // Step 2: Overlap guard (task-level — prevents gate re-entry)
  if (running.get(task.id)) {
    logger.info(`[scheduler] ${task.id}: still running, skipping tick`);
    ledger.record({
      task_id: task.id,
      subject_key: task.id,
      outcome: 'SKIP_OVERLAP',
      signal_summary: null,
      duration_ms: Date.now() - startMs,
      started_at: new Date(startMs).toISOString(),
      assigned_cat_id: null,
      error_summary: null,
    });
    return;
  }
  running.set(task.id, true);

  try {
    // Step 3: Gate — returns workItems[]
    const gateCtx: GateCtx = {
      taskId: task.id,
      lastRunAt: lastRunAt.get(task.id) ?? null,
      tickCount,
    };

    const gateResult = await task.admission.gate(gateCtx);

    if (!gateResult.run) {
      if (task.outcome.whenNoSignal === 'record') {
        ledger.record({
          task_id: task.id,
          subject_key: task.id,
          outcome: 'SKIP_NO_SIGNAL',
          signal_summary: null,
          duration_ms: Date.now() - startMs,
          started_at: new Date(startMs).toISOString(),
          assigned_cat_id: null,
          error_summary: null,
        });
      }
      return;
    }

    // Phase 1b: Actor resolution — resolve once per task tick, not per workItem
    const assignedCatId = task.actor && actorResolver ? actorResolver(task.actor.role, task.actor.costTier) : null;

    // Step 4 + 5: Execute per workItem → ledger per subject
    const pendingExecutes: Promise<void>[] = [];

    for (const item of gateResult.workItems) {
      const itemStartMs = Date.now();

      // AC-D2: Self-echo suppression — skip thread workItems where this task recently posted
      if (emissionStore && item.subjectKey.startsWith('thread-')) {
        const threadId = item.subjectKey.slice(7);
        if (emissionStore.isSuppressed(task.id, threadId)) {
          ledger.record({
            task_id: task.id,
            subject_key: item.subjectKey,
            outcome: 'SKIP_SELF_ECHO',
            signal_summary: null,
            duration_ms: Date.now() - itemStartMs,
            started_at: new Date(itemStartMs).toISOString(),
            assigned_cat_id: null,
            error_summary: null,
          });
          continue;
        }
      }

      let outcome: RunOutcome = 'RUN_DELIVERED';
      // Phase 2: pass context spec through ExecuteContext
      const rawExecute = task.run.execute(item.signal, item.subjectKey, {
        assignedCatId,
        context: task.context,
        deliver,
        fetchContent,
        invokeTrigger,
      });
      pendingExecutes.push(rawExecute.catch(() => {}));
      let errorSummary: string | null = null;
      try {
        await withTimeout(rawExecute, task.run.timeoutMs, task.id);
      } catch (err) {
        outcome = 'RUN_FAILED';
        errorSummary = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        logger.error(`[scheduler] ${task.id}/${item.subjectKey}: failed`, err);
      }

      ledger.record({
        task_id: task.id,
        subject_key: item.subjectKey,
        outcome,
        signal_summary: typeof item.signal === 'string' ? item.signal : JSON.stringify(item.signal).slice(0, 200),
        duration_ms: Date.now() - itemStartMs,
        started_at: new Date(itemStartMs).toISOString(),
        assigned_cat_id: assignedCatId,
        error_summary: errorSummary,
      });

      // AC-D2: Record emission after successful thread-scoped delivery for self-echo suppression
      if (outcome === 'RUN_DELIVERED' && emissionStore && item.subjectKey.startsWith('thread-')) {
        const threadId = item.subjectKey.slice(7);
        const suppressionMs = task.trigger.type === 'interval' ? Math.max(task.trigger.ms * 2, 60_000) : 300_000;
        emissionStore.record({
          originTaskId: task.id,
          threadId,
          messageId: `run-${task.id}-${Date.now()}`,
          suppressionMs,
        });
      }
    }

    lastRunAt.set(task.id, Date.now());
    logger.info(
      `[scheduler] ${task.id}: tick completed, ${gateResult.workItems.length} items (${Date.now() - startMs}ms)`,
    );

    await Promise.allSettled(pendingExecutes);
  } finally {
    running.set(task.id, false);
  }
}
