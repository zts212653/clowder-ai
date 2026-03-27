import { getNextCronMs } from './cron-utils.js';
import type { RunLedger } from './RunLedger.js';
import type { ActorRole, CostTier, GateCtx, RunOutcome, ScheduleTaskSummary, TaskSpec_P1 } from './types.js';

export interface TaskRunnerV2Options {
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  ledger: RunLedger;
  /** Phase 1b: optional actor resolver — maps role + costTier to catId */
  actorResolver?: (role: ActorRole, costTier: CostTier) => string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTaskSpec = TaskSpec_P1<any>;

export class TaskRunnerV2 {
  private tasks: AnyTaskSpec[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, boolean>();
  private tickCounts = new Map<string, number>();
  private lastRunAt = new Map<string, number | null>();
  private logger: TaskRunnerV2Options['logger'];
  private ledger: RunLedger;
  private actorResolver: TaskRunnerV2Options['actorResolver'];

  constructor(opts: TaskRunnerV2Options) {
    this.logger = opts.logger;
    this.ledger = opts.ledger;
    this.actorResolver = opts.actorResolver;
  }

  register(task: AnyTaskSpec): void {
    if (this.tasks.some((t) => t.id === task.id)) {
      throw new Error(`TaskRunnerV2: duplicate task id "${task.id}"`);
    }
    this.tasks.push(task);
  }

  start(): void {
    for (const task of this.tasks) {
      if (this.timers.has(task.id)) continue;
      this.running.set(task.id, false);
      this.tickCounts.set(task.id, 0);
      this.lastRunAt.set(task.id, null);

      if (task.trigger.type === 'cron') {
        this.scheduleCronTick(task);
      } else {
        const runTick = () => {
          this.executePipeline(task).catch((err) => {
            this.logger.error(`[scheduler] ${task.id}: pipeline error`, err);
          });
        };
        // Fire first tick asynchronously, then start interval
        setTimeout(runTick, 0);
        const timer = setInterval(runTick, task.trigger.ms);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
        this.timers.set(task.id, timer);
        this.logger.info(`[scheduler] ${task.id}: registered (profile=${task.profile}, interval=${task.trigger.ms}ms)`);
      }
    }
  }

  /** Schedule next cron tick via setTimeout chain */
  private scheduleCronTick(task: AnyTaskSpec): void {
    if (task.trigger.type !== 'cron') return;
    const ms = getNextCronMs(task.trigger.expression, task.trigger.timezone);
    const timer = setTimeout(() => {
      this.executePipeline(task)
        .catch((err) => {
          this.logger.error(`[scheduler] ${task.id}: pipeline error`, err);
        })
        .finally(() => {
          // Schedule next occurrence
          if (this.timers.has(task.id)) {
            this.scheduleCronTick(task);
          }
        });
    }, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.timers.set(task.id, timer);
    this.logger.info(
      `[scheduler] ${task.id}: registered (profile=${task.profile}, cron="${task.trigger.expression}", next in ${ms}ms)`,
    );
  }

  stop(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
      this.logger.info(`[scheduler] ${id}: stopped`);
    }
    this.timers.clear();
  }

  async triggerNow(taskId: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`TaskRunnerV2: unknown task "${taskId}"`);
    await this.executePipeline(task);
  }

  getRegisteredTasks(): string[] {
    return this.tasks.map((t) => t.id);
  }

  /** Phase 2: Full task summaries for schedule panel API */
  getTaskSummaries(): ScheduleTaskSummary[] {
    return this.tasks.map((task) => {
      const lastRuns = this.ledger.query(task.id, 1);
      const stats = this.ledger.stats(task.id);
      return {
        id: task.id,
        profile: task.profile,
        trigger: task.trigger,
        enabled: task.enabled(),
        actor: task.actor,
        context: task.context,
        lastRun: lastRuns[0] ?? null,
        runStats: stats,
      };
    });
  }

  /** Expose ledger for route handlers */
  getLedger(): RunLedger {
    return this.ledger;
  }

  private withTimeout(promise: Promise<void>, ms: number, taskId: string): Promise<void> {
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

  private async executePipeline(task: AnyTaskSpec): Promise<void> {
    const startMs = Date.now();
    const tickCount = (this.tickCounts.get(task.id) ?? 0) + 1;
    this.tickCounts.set(task.id, tickCount);

    // Step 1: Enabled check
    if (!task.enabled()) return;

    // Step 2: Overlap guard (task-level — prevents gate re-entry)
    if (this.running.get(task.id)) {
      this.logger.info(`[scheduler] ${task.id}: still running, skipping tick`);
      this.ledger.record({
        task_id: task.id,
        subject_key: task.id,
        outcome: 'SKIP_OVERLAP',
        signal_summary: null,
        duration_ms: Date.now() - startMs,
        started_at: new Date(startMs).toISOString(),
        assigned_cat_id: null,
      });
      return;
    }
    this.running.set(task.id, true);

    try {
      // Step 3: Gate — returns workItems[]
      const ctx: GateCtx = {
        taskId: task.id,
        lastRunAt: this.lastRunAt.get(task.id) ?? null,
        tickCount,
      };

      const gateResult = await task.admission.gate(ctx);

      if (!gateResult.run) {
        if (task.outcome.whenNoSignal === 'record') {
          this.ledger.record({
            task_id: task.id,
            subject_key: task.id,
            outcome: 'SKIP_NO_SIGNAL',
            signal_summary: null,
            duration_ms: Date.now() - startMs,
            started_at: new Date(startMs).toISOString(),
            assigned_cat_id: null,
          });
        }
        return;
      }

      // Phase 1b: Actor resolution — resolve once per task tick, not per workItem
      const assignedCatId =
        task.actor && this.actorResolver ? this.actorResolver(task.actor.role, task.actor.costTier) : null;

      // Step 4 + 5: Execute per workItem → ledger per subject
      const pendingExecutes: Promise<void>[] = [];

      for (const item of gateResult.workItems) {
        const itemStartMs = Date.now();
        let outcome: RunOutcome = 'RUN_DELIVERED';
        // Phase 2: pass context spec through ExecuteContext
        const rawExecute = task.run.execute(item.signal, item.subjectKey, {
          assignedCatId,
          context: task.context,
        });
        pendingExecutes.push(rawExecute.catch(() => {}));
        try {
          await this.withTimeout(rawExecute, task.run.timeoutMs, task.id);
        } catch (err) {
          outcome = 'RUN_FAILED';
          this.logger.error(`[scheduler] ${task.id}/${item.subjectKey}: failed`, err);
        }

        this.ledger.record({
          task_id: task.id,
          subject_key: item.subjectKey,
          outcome,
          signal_summary: typeof item.signal === 'string' ? item.signal : JSON.stringify(item.signal).slice(0, 200),
          duration_ms: Date.now() - itemStartMs,
          started_at: new Date(itemStartMs).toISOString(),
          assigned_cat_id: assignedCatId,
        });
      }

      this.lastRunAt.set(task.id, Date.now());
      this.logger.info(
        `[scheduler] ${task.id}: tick completed, ${gateResult.workItems.length} items (${Date.now() - startMs}ms)`,
      );

      await Promise.allSettled(pendingExecutes);
    } finally {
      this.running.set(task.id, false);
    }
  }
}
