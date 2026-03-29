import { getNextCronMs } from './cron-utils.js';
import type { DynamicTaskStore } from './DynamicTaskStore.js';
import { executeTaskPipeline } from './execute-pipeline.js';
import type { RunLedger } from './RunLedger.js';
import type { TaskTemplate } from './templates/types.js';
import type {
  ActorRole,
  CostTier,
  DeliverOpts,
  FetchResult,
  RunLedgerRow,
  ScheduleInvokeTrigger,
  ScheduleTaskSummary,
  SubjectKind,
  TaskSource,
  TaskSpec_P1,
} from './types.js';

export interface TaskRunnerV2Options {
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  ledger: RunLedger;
  /** Phase 1b: optional actor resolver — maps role + costTier to catId */
  actorResolver?: (role: ActorRole, costTier: CostTier) => string | null;
  /** Phase 3B (AC-D1): governance store for global pause + task overrides */
  globalControlStore?: import('./GlobalControlStore.js').GlobalControlStore;
  /** Phase 3B (AC-D2): emission store for self-echo suppression */
  emissionStore?: import('./EmissionStore.js').EmissionStore;
  /** Phase 4 (AC-H1): deliver message to a thread */
  deliver?: (opts: DeliverOpts) => Promise<string>;
  /** Phase 4 (AC-H2): fetch web content with browser-automation routing */
  fetchContent?: (url: string) => Promise<FetchResult>;
  /** Phase 4b: invoke a cat to handle a scheduled task (fire-and-forget) */
  invokeTrigger?: ScheduleInvokeTrigger;
}

/** Phase 2.5: Compute human-readable subject preview from subjectKind + lastRun (AC-E2) */
export function computeSubjectPreview(
  subjectKind: SubjectKind | undefined,
  lastRun: RunLedgerRow | null,
): string | null {
  if (!lastRun || !subjectKind || subjectKind === 'none') return null;
  const key = lastRun.subject_key;
  // Strict prefix matching: unrecognized keys (e.g. task.id from SKIP_NO_SIGNAL) → null
  switch (subjectKind) {
    case 'pr': {
      if (!key.startsWith('pr-')) return null;
      return key.slice(3);
    }
    case 'thread': {
      if (key.startsWith('thread-')) return formatThreadPreview(key.slice(7));
      if (key.startsWith('thread:')) return formatThreadPreview(key.slice(7));
      return null;
    }
    case 'repo': {
      // F141 real format: "repo-owner/repo#pr-42" or "repo:owner/name"
      if (key.startsWith('repo-')) return key.slice(5);
      if (key.startsWith('repo:')) return key.slice(5);
      return null;
    }
    case 'external': {
      return key;
    }
    default:
      return null;
  }
}

function formatThreadPreview(id: string): string {
  return id ? `Thread ${id.slice(0, 8)}…` : 'Thread';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTaskSpec = TaskSpec_P1<any>;

export class TaskRunnerV2 {
  private tasks: AnyTaskSpec[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, boolean>();
  private tickCounts = new Map<string, number>();
  private lastRunAt = new Map<string, number | null>();
  /** Phase 3A: track dynamic task IDs → DynamicTaskDef.id mapping */
  private dynamicTaskIds = new Map<string, string>();
  /** True after start() has been called — used to auto-schedule late-registered tasks */
  private started = false;
  private logger: TaskRunnerV2Options['logger'];
  private ledger: RunLedger;
  private actorResolver: TaskRunnerV2Options['actorResolver'];
  private globalControlStore: TaskRunnerV2Options['globalControlStore'];
  private emissionStore: TaskRunnerV2Options['emissionStore'];
  private deliver: TaskRunnerV2Options['deliver'];
  private fetchContent: TaskRunnerV2Options['fetchContent'];
  private invokeTrigger: TaskRunnerV2Options['invokeTrigger'];

  constructor(opts: TaskRunnerV2Options) {
    this.logger = opts.logger;
    this.ledger = opts.ledger;
    this.actorResolver = opts.actorResolver;
    this.globalControlStore = opts.globalControlStore;
    this.emissionStore = opts.emissionStore;
    this.deliver = opts.deliver;
    this.fetchContent = opts.fetchContent;
    this.invokeTrigger = opts.invokeTrigger;
  }

  /** Late-bind invokeTrigger (constructed after TaskRunnerV2 in boot sequence) */
  setInvokeTrigger(trigger: ScheduleInvokeTrigger): void {
    this.invokeTrigger = trigger;
  }

  register(task: AnyTaskSpec): void {
    if (this.tasks.some((t) => t.id === task.id)) {
      throw new Error(`TaskRunnerV2: duplicate task id "${task.id}"`);
    }
    this.tasks.push(task);
  }

  /** Phase 3A: register a dynamic task and track its def ID */
  registerDynamic(task: AnyTaskSpec, dynamicDefId: string): void {
    this.register(task);
    this.dynamicTaskIds.set(task.id, dynamicDefId);
    // If runner is already started, schedule timer immediately — but defer first tick
    // so that user-registered tasks don't fire at t=0 (bug: "注册上就出触发了")
    if (this.started) {
      this.scheduleTask(task, /* deferFirstTick */ true);
    }
  }

  /** Phase 3A: unregister a task by spec ID (stops timer if running) */
  unregister(taskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    this.running.delete(taskId);
    this.tickCounts.delete(taskId);
    this.lastRunAt.delete(taskId);
    this.dynamicTaskIds.delete(taskId);
    return true;
  }

  /** Phase 3A: hydrate dynamic tasks from persistent store (AC-G3) */
  hydrateDynamic(store: DynamicTaskStore, templateGetter: { get: (id: string) => TaskTemplate | null }): number {
    const defs = store.getAll().filter((d) => d.enabled);
    let loaded = 0;
    for (const def of defs) {
      const template = templateGetter.get(def.templateId);
      if (!template) {
        this.logger.error(`[scheduler] hydrate: unknown template "${def.templateId}" for def ${def.id}`);
        continue;
      }
      const spec = template.createSpec(def.id, {
        trigger: def.trigger,
        params: def.params,
        deliveryThreadId: def.deliveryThreadId,
      });
      // Override display with persisted display
      spec.display = def.display;
      try {
        this.registerDynamic(spec, def.id);
        loaded++;
      } catch {
        // Duplicate — skip
      }
    }
    return loaded;
  }

  start(): void {
    this.started = true;
    for (const task of this.tasks) {
      this.scheduleTask(task);
    }
  }

  /**
   * Initialize tracking state and set up timer for a single task.
   * @param deferFirstTick - when true, skip the immediate first tick (for live-registered dynamic tasks)
   */
  private scheduleTask(task: AnyTaskSpec, deferFirstTick = false): void {
    if (this.timers.has(task.id)) return;
    this.running.set(task.id, false);
    this.tickCounts.set(task.id, 0);
    this.lastRunAt.set(task.id, null);

    if (task.trigger.type === 'cron') {
      this.scheduleCronTick(task);
    } else {
      const runTick = () => {
        // Guard: skip if task was unregistered before tick fires (防幽灵执行)
        if (!this.timers.has(task.id)) return;
        this.executePipeline(task).catch((err) => {
          this.logger.error(`[scheduler] ${task.id}: pipeline error`, err);
        });
      };
      if (!deferFirstTick) {
        // Boot: fire first tick immediately for pollers that need to check pending work
        setTimeout(runTick, 0);
      }
      const timer = setInterval(runTick, task.trigger.ms);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.timers.set(task.id, timer);
      this.logger.info(`[scheduler] ${task.id}: registered (profile=${task.profile}, interval=${task.trigger.ms}ms)`);
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
    this.started = false;
  }

  async triggerNow(taskId: string, opts?: { manual?: boolean }): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`TaskRunnerV2: unknown task "${taskId}"`);
    await this.executePipeline(task, opts?.manual);
  }

  getRegisteredTasks(): string[] {
    return this.tasks.map((t) => t.id);
  }

  /** Phase 2: Full task summaries for schedule panel API */
  getTaskSummaries(): ScheduleTaskSummary[] {
    const globalEnabled = this.globalControlStore ? this.globalControlStore.getGlobalEnabled() : true;
    return this.tasks.map((task) => {
      const lastRuns = this.ledger.query(task.id, 1);
      const stats = this.ledger.stats(task.id);
      const dynDefId = this.dynamicTaskIds.get(task.id);
      const taskEnabled = task.enabled();
      // AC-D1: effectiveEnabled reflects global pause + task override + task.enabled
      let effectiveEnabled = taskEnabled;
      if (effectiveEnabled && this.globalControlStore) {
        if (!globalEnabled) effectiveEnabled = false;
        const override = this.globalControlStore.getTaskOverride(task.id);
        if (override && !override.enabled) effectiveEnabled = false;
      }
      return {
        id: task.id,
        profile: task.profile,
        trigger: task.trigger,
        enabled: taskEnabled,
        effectiveEnabled,
        actor: task.actor,
        context: task.context,
        lastRun: lastRuns[0] ?? null,
        runStats: stats,
        display: task.display,
        subjectPreview: computeSubjectPreview(task.display?.subjectKind, lastRuns[0] ?? null),
        source: (dynDefId ? 'dynamic' : 'builtin') as TaskSource,
        dynamicTaskId: dynDefId,
      };
    });
  }

  /** Expose ledger for route handlers */
  getLedger(): RunLedger {
    return this.ledger;
  }

  private async executePipeline(task: AnyTaskSpec, isManualTrigger?: boolean): Promise<void> {
    await executeTaskPipeline({
      task,
      ledger: this.ledger,
      logger: this.logger,
      running: this.running,
      tickCounts: this.tickCounts,
      lastRunAt: this.lastRunAt,
      actorResolver: this.actorResolver,
      globalControlStore: this.globalControlStore,
      emissionStore: this.emissionStore,
      isManualTrigger,
      deliver: this.deliver,
      fetchContent: this.fetchContent,
      invokeTrigger: this.invokeTrigger,
    });
  }
}
