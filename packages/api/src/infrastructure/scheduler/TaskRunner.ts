import type { ScheduledTask } from './types.js';

/**
 * MVP TaskRunner: setInterval-based scheduler.
 *
 * Future upgrade path: replace internals with cron / persistent queue / distributed lock.
 * All registered tasks implement ScheduledTask interface — zero changes to task code on upgrade.
 */
export class TaskRunner {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = new Map<string, boolean>();
  private logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };

  constructor(logger?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void }) {
    this.logger = logger ?? { info: console.log, error: console.error };
  }

  register(task: ScheduledTask): void {
    if (this.tasks.some((t) => t.name === task.name)) {
      throw new Error(`TaskRunner: duplicate task name "${task.name}"`);
    }
    this.tasks.push(task);
  }

  start(): void {
    for (const task of this.tasks) {
      if (this.timers.has(task.name)) continue;
      this.running.set(task.name, false);

      const runTick = async () => {
        if (!task.enabled()) return;
        if (this.running.get(task.name)) {
          this.logger.info(`[scheduler] ${task.name}: still running, skipping tick`);
          return;
        }
        this.running.set(task.name, true);
        const startMs = Date.now();
        try {
          await task.execute();
          this.logger.info(`[scheduler] ${task.name}: tick completed (${Date.now() - startMs}ms)`);
        } catch (err) {
          this.logger.error(`[scheduler] ${task.name}: tick failed (${Date.now() - startMs}ms)`, err);
        } finally {
          this.running.set(task.name, false);
        }
      };

      // Run first tick immediately on startup (don't wait intervalMs)
      setTimeout(runTick, 0);

      const timer = setInterval(runTick, task.intervalMs);

      // Unref so the timer doesn't prevent process exit
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }

      this.timers.set(task.name, timer);
      this.logger.info(
        `[scheduler] ${task.name}: registered (interval=${task.intervalMs}ms, enabled=${task.enabled()})`,
      );
    }
  }

  stop(): void {
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      this.logger.info(`[scheduler] ${name}: stopped`);
    }
    this.timers.clear();
  }

  /** Manually trigger a task (for testing / backfill). */
  async triggerNow(taskName: string): Promise<void> {
    const task = this.tasks.find((t) => t.name === taskName);
    if (!task) throw new Error(`TaskRunner: unknown task "${taskName}"`);
    await task.execute();
  }

  getRegisteredTasks(): string[] {
    return this.tasks.map((t) => t.name);
  }
}
