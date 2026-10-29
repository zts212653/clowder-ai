import type { BuiltinBrokerConnection } from '../host-broker/builtin-loopback.js';
import { StaticFeatureAuthority } from '../host-broker/static-feature-authority.js';
import { ObservationDiagnostics } from './observation-diagnostics.js';
import type { DesktopWindowFailure, DesktopWindowHandle, DesktopWindowPresence } from './types.js';

interface ObservationAttempt {
  phase: 'poll' | 'authority' | 'lease-renew';
  pending: boolean;
  startedAtMs: number;
  deadlineAtMs: number;
  startedMonotonicMs: number;
  diagnostics: ObservationDiagnostics;
}

interface Options {
  readonly id: string;
  readonly window: DesktopWindowHandle;
  readonly lease: string;
  readonly connection: BuiltinBrokerConnection;
  readonly features: StaticFeatureAuthority;
  readonly freshnessMs: number;
  readonly now: () => number;
  readonly isCurrent: () => boolean;
}

/** Poll the native child outside store transactions; retain only bounded timing on failure. */
export class DesktopWindowObserver {
  observation?: DesktopWindowPresence;
  private attempt?: ObservationAttempt;
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private nextPollAtMonotonicMs?: number;

  constructor(private readonly options: Options) {}

  observe(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operation = this.observeOnce().finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  async observeAfterShow(): Promise<void> {
    // A poll sent before show cannot certify the new visibility. Wait for it,
    // then issue exactly one fresh poll; a failed earlier poll stays terminal.
    if (this.inFlight) await this.inFlight;
    await this.observe();
  }

  private async observeOnce(): Promise<void> {
    if (!this.options.isCurrent()) throw new Error('desktop window ended');
    const { lease, connection, features, freshnessMs, now, isCurrent, id } = this.options;
    const deadlineMs = Math.floor(freshnessMs / 3);
    const startedAtMs = now();
    const attempt: ObservationAttempt = {
      phase: 'poll',
      pending: true,
      startedAtMs,
      deadlineAtMs: startedAtMs + deadlineMs,
      startedMonotonicMs: performance.now(),
      diagnostics: new ObservationDiagnostics(),
    };
    this.attempt = attempt;
    this.nextPollAtMonotonicMs = attempt.startedMonotonicMs + deadlineMs;
    let sample = await this.poll(attempt);
    // Only a fresh native reply may renew a still-current Broker binding.
    // Expired bindings fail here; renewal never revives old feature authority.
    attempt.phase = 'lease-renew';
    await attempt.diagnostics.measure('lease-renew', () => connection.renewRuntimeLease());
    attempt.phase = 'authority';
    await attempt.diagnostics.measure('authority', () =>
      features.run(
        lease,
        (authority) =>
          attempt.diagnostics.measure('observation-publish', async () => {
            const publishedAt = now();
            attempt.diagnostics.costs.publish(publishedAt);
            if (publishedAt - sample.receivedAt >= freshnessMs) throw new Error('desktop observation expired');
            const contributionId = authority.contributionIds[0];
            if (!contributionId) throw new Error('desktop authority without contribution');
            this.observation = {
              pluginInstanceId: id,
              contributionId,
              state: sample.state,
              observedAt: sample.receivedAt,
              expiresAt: sample.receivedAt + freshnessMs,
            };
          }),
        attempt.diagnostics,
        async () => {
          if (!isCurrent()) throw new Error('desktop window ended');
          // Keep the fast path's genuine reply. If Host IO has spent its
          // normal heartbeat interval, ask the child once more outside the
          // stores, then publish only after the original current checks.
          // Never retry a failed poll or change an earlier reply's timestamp.
          if (now() - sample.receivedAt >= deadlineMs) sample = await this.poll(attempt, true);
          attempt.phase = 'authority';
        },
      ),
    );
    if (this.attempt === attempt) this.attempt = undefined;
  }

  private async poll(attempt: ObservationAttempt, refreshing = false) {
    const { window, freshnessMs, now, isCurrent } = this.options;
    attempt.phase = 'poll';
    attempt.pending = true;
    const deadlineMs = Math.floor(freshnessMs / 3);
    attempt.deadlineAtMs = now() + deadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const poll = Promise.resolve()
        .then(() => window.poll())
        .finally(() => {
          attempt.pending = false;
        });
      const state = await attempt.diagnostics.measure(refreshing ? 'poll-refresh' : 'poll', () =>
        Promise.race([
          poll,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('desktop heartbeat expired')), deadlineMs);
            timer.unref();
          }),
        ]),
      );
      const receivedAt = now();
      if (refreshing) attempt.diagnostics.costs.refresh(receivedAt);
      else attempt.diagnostics.costs.receive(receivedAt);
      if (!isCurrent()) throw new Error('desktop window ended');
      return { state, receivedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  start(onFailure: (error: unknown) => void): void {
    const intervalMs = Math.max(1, Math.floor(this.options.freshnessMs / 3));
    // Host preparation already counts toward the heartbeat interval. Sleeping
    // another full interval after slow work can exhaust a still-live lease.
    const delayMs =
      this.nextPollAtMonotonicMs === undefined
        ? intervalMs
        : Math.max(1, Math.min(intervalMs, Math.ceil(this.nextPollAtMonotonicMs - performance.now())));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.observe().then(() => {
        if (this.options.isCurrent()) this.start(onFailure);
      }, onFailure);
    }, delayMs);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.attempt = undefined;
    this.nextPollAtMonotonicMs = undefined;
  }

  diagnostic(error?: unknown): DesktopWindowFailure['observation'] {
    const attempt = this.attempt;
    if (!attempt) return undefined;
    return {
      phase: attempt.phase,
      pending: attempt.pending,
      startedAtMs: attempt.startedAtMs,
      deadlineAtMs: attempt.deadlineAtMs,
      elapsedMs: Math.max(0, Math.round(performance.now() - attempt.startedMonotonicMs)),
      lastPollAnswerAgeMs: this.observation ? Math.max(0, this.options.now() - this.observation.observedAt) : null,
      ...attempt.diagnostics.snapshot(error),
    };
  }
}
