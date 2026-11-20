import { type Profiler, Session } from 'node:inspector';
import { ProfilerControlTimeline } from './event-loop-tripwire-controls.js';

type Options = {
  budgetMs: number;
  emit(report: object): void;
  ready(): void;
  safety(safe: boolean): void;
  beat(): void;
};

/** Inspector owns only sampling. A failed protocol never shuts down the independent observer. */
export class EventLoopProfilerSession {
  readonly timeline = new ProfilerControlTimeline();
  private readonly session = new Session();
  private startRequestedAt: number | undefined;
  private reason: 'start_budget_exceeded' | 'profiler_failed' | undefined;
  private failure = false;
  private released = true; // No start has been dispatched yet.
  private cleanup: Promise<void> | undefined;

  constructor(private readonly options: Options) {
    options.safety(true);
    try {
      this.session.connectToMainThread();
    } catch {
      void this.fail();
    }
  }

  get suspended() {
    return this.reason !== undefined;
  }
  get failed() {
    return this.failure;
  }
  get canRelease() {
    return this.released;
  }

  private safety(safe: boolean) {
    this.released = safe;
    this.options.safety(safe);
  }

  async command(method: string, params: object = {}) {
    if (this.failure && method !== 'Profiler.disable') throw Error('profiler_failed');
    const entered = performance.now();
    if (method === 'Profiler.start') this.startRequestedAt = entered;
    if (method === 'Profiler.start' || method === 'Profiler.stop') this.safety(false);
    this.timeline.begin(entered);
    try {
      const result = await new Promise<{ profile?: Profiler.Profile }>((resolve, reject) => {
        this.session.post(method, params, (error, response) =>
          error ? reject(error) : resolve((response ?? {}) as { profile?: Profiler.Profile }),
        );
      });
      if (method === 'Profiler.stop' || method === 'Profiler.disable') this.safety(true);
      return result;
    } finally {
      const acknowledged = performance.now();
      this.checkBudget(acknowledged);
      if (method === 'Profiler.start') this.startRequestedAt = undefined;
      this.timeline.finish(acknowledged);
      this.options.beat();
      if (method === 'Profiler.start' || method === 'Profiler.stop')
        this.options.emit({
          kind: 'event_loop_profiler_control',
          method,
          requestedAtMs: entered,
          acknowledgedAtMs: acknowledged,
          controlMs: acknowledged - entered,
        });
    }
  }

  checkBudget(now: number) {
    if (this.suspended || this.startRequestedAt === undefined || now - this.startRequestedAt <= this.options.budgetMs)
      return;
    this.reason = 'start_budget_exceeded';
    this.options.emit({
      kind: 'event_loop_profiler_policy',
      status: 'profiler_suspended',
      reason: this.reason,
      requestedAtMs: this.startRequestedAt,
      elapsedMs: now - this.startRequestedAt,
      budgetMs: this.options.budgetMs,
    });
    this.options.ready();
  }

  fail(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.failure = true;
    this.reason = 'profiler_failed';
    this.options.emit({
      kind: 'event_loop_profiler_policy',
      status: 'profiler_failed',
      reason: 'inspector_command_failed',
    });
    this.options.ready();
    this.cleanup = this.releaseAfterFailure();
    return this.cleanup;
  }

  private async releaseAfterFailure() {
    try {
      // A successful stop/disable acknowledgement, or never having started, is
      // proof. disconnect() merely queues cross-thread teardown and is not proof.
      if (!this.released) await this.command('Profiler.disable');
    } catch {
      this.safety(false);
    } finally {
      this.disconnect();
      this.options.emit({
        kind: 'event_loop_profiler_policy',
        status: this.released ? 'profiler_disabled' : 'profiler_blocked',
        reason: this.released ? 'profiler_unload_confirmed' : 'profiler_unload_unproven',
      });
    }
  }

  disconnect() {
    try {
      this.session.disconnect();
    } catch {
      /* Retain the last explicit safety proof. */
    }
  }
}
