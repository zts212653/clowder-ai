import type { BuiltinBrokerConnection } from '../host-broker/builtin-loopback.js';
import { StaticFeatureAuthority } from '../host-broker/static-feature-authority.js';
import type { DesktopWindowFailure, DesktopWindowHandle, DesktopWindowPresence } from './types.js';

interface ObservationAttempt {
  phase: 'poll' | 'authority' | 'lease-renew';
  pending: boolean;
  startedAtMs: number;
  deadlineAtMs: number;
  startedMonotonicMs: number;
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
    const { window, lease, connection, features, freshnessMs, now, isCurrent, id } = this.options;
    const deadlineMs = Math.floor(freshnessMs / 3);
    const startedAtMs = now();
    const attempt: ObservationAttempt = {
      phase: 'poll',
      pending: true,
      startedAtMs,
      deadlineAtMs: startedAtMs + deadlineMs,
      startedMonotonicMs: performance.now(),
    };
    this.attempt = attempt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const poll = Promise.resolve()
        .then(() => window.poll())
        .then(
          (state) => {
            attempt.pending = false;
            return state;
          },
          (error: unknown) => {
            attempt.pending = false;
            throw error;
          },
        );
      const state = await Promise.race([
        poll,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('desktop heartbeat expired')), deadlineMs);
          timer.unref();
        }),
      ]);
      const receivedAt = now();
      if (!isCurrent()) throw new Error('desktop window ended');
      // Only a fresh native reply may renew a still-current Broker binding.
      // Expired bindings fail here; renewal never revives old feature authority.
      attempt.phase = 'lease-renew';
      await connection.renewRuntimeLease();
      attempt.phase = 'authority';
      await features.run(lease, async (authority) => {
        if (now() - receivedAt >= freshnessMs) throw new Error('desktop observation expired');
        const contributionId = authority.contributionIds[0];
        if (!contributionId) throw new Error('desktop authority without contribution');
        this.observation = {
          pluginInstanceId: id,
          contributionId,
          state,
          observedAt: receivedAt,
          expiresAt: receivedAt + freshnessMs,
        };
      });
      if (this.attempt === attempt) this.attempt = undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  start(onFailure: (error: unknown) => void): void {
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.observe().then(() => {
          if (this.options.isCurrent()) this.start(onFailure);
        }, onFailure);
      },
      Math.max(1, Math.floor(this.options.freshnessMs / 3)),
    );
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.attempt = undefined;
  }

  diagnostic(): DesktopWindowFailure['observation'] {
    const attempt = this.attempt;
    if (!attempt) return undefined;
    return {
      phase: attempt.phase,
      pending: attempt.pending,
      startedAtMs: attempt.startedAtMs,
      deadlineAtMs: attempt.deadlineAtMs,
      elapsedMs: Math.max(0, Math.round(performance.now() - attempt.startedMonotonicMs)),
      lastPollAnswerAgeMs: this.observation ? Math.max(0, this.options.now() - this.observation.observedAt) : null,
    };
  }
}
