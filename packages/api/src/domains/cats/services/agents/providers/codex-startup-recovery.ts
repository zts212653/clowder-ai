import type { CodexStartupRecovery } from '@cat-cafe/shared';
import { CodexAppServerRpcError } from './codex-app-server-rpc-error.js';
import {
  buildCodexStartupDiagnostics,
  codexStartupEvidence,
  isRetryableCodexStartupError,
} from './codex-startup-diagnostics.js';

export interface CodexStartupRecoveryOptions {
  retryDelaysMs?: readonly number[];
  budgetMs?: number;
  now?: () => number;
}
export interface CodexStartupRecoveryEvent {
  type: 'app_server.startup_recovery';
  startupRecovery: CodexStartupRecovery;
}

/** A single invocation budget, kept across client rebuilds. Does not own an account or replay work. */
export class CodexStartupRecoveryBudget {
  readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private state?: CodexStartupRecovery;
  private lastError?: unknown;
  private lastErrorAttempt?: number;
  private readonly delays: readonly number[];
  constructor(
    private readonly invocationId: string,
    private readonly options: CodexStartupRecoveryOptions = {},
  ) {
    this.delays = options.retryDelaysMs ?? [2_000, 5_000, 10_000, 20_000, 30_000];
  }
  get snapshot() {
    return this.state;
  }
  get waiting() {
    return this.state?.stage === 'retry_wait';
  }
  get checking() {
    return this.state?.stage === 'checking';
  }
  get expired() {
    return this.controller.signal.aborted;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  begin(): CodexStartupRecoveryEvent {
    if (!this.state) {
      const startedAt = this.now();
      const budgetMs = Math.max(1, this.options.budgetMs ?? 120_000);
      this.state = {
        invocationId: this.invocationId,
        stage: 'checking',
        sequence: 0,
        attempt: 0,
        maxAttempts: this.delays.length + 1,
        startedAt,
        deadlineAt: startedAt + budgetMs,
        updatedAt: startedAt,
      };
      this.timer = setTimeout(
        () => this.controller.abort(new Error('Codex account startup recovery deadline exceeded')),
        budgetMs,
      );
    }
    this.state = { ...this.state, attempt: this.state.attempt + 1, nextRetryAt: undefined };
    return this.event('checking');
  }

  ready(): CodexStartupRecoveryEvent {
    this.dispose();
    return this.event('ready');
  }

  retry(error: unknown, reconnecting: boolean): CodexStartupRecoveryEvent | null {
    if (
      !this.state ||
      this.expired ||
      this.now() >= this.state.deadlineAt ||
      this.state.attempt >= this.state.maxAttempts
    )
      return null;
    // A reconnect failure belongs to the already-admitted episode; arbitrary initial errors do not.
    const evidence = codexStartupEvidence(error);
    if (evidence.category === 'auth_rejected' || evidence.category === 'configuration_conflict') return null;
    if (!isRetryableCodexStartupError(error) && (!reconnecting || error instanceof CodexAppServerRpcError)) return null;
    this.lastError = error;
    this.lastErrorAttempt = this.state.attempt;
    const delayMs = Math.max(0, this.delays[this.state.attempt - 1], evidence.retryAfterMs ?? 0);
    const nextRetryAt = this.now() + delayMs;
    if (nextRetryAt >= this.state.deadlineAt) return null;
    this.state = { ...this.state, nextRetryAt };
    return this.event('retry_wait');
  }

  finish(error: unknown, cancelled: boolean): CodexStartupRecoveryEvent {
    if (!(this.expired && this.lastError)) {
      this.lastError = error;
      this.lastErrorAttempt = this.state?.attempt;
    }
    this.dispose();
    return this.event(cancelled ? 'cancelled' : 'failed');
  }

  private event(stage: CodexStartupRecovery['stage']): CodexStartupRecoveryEvent {
    if (!this.state) throw new Error('startup budget not started');
    const updatedAt = this.now();
    this.state = {
      ...this.state,
      stage,
      sequence: this.state.sequence + 1,
      updatedAt,
      ...(this.lastError
        ? {
            diagnostics: buildCodexStartupDiagnostics(
              this.lastError,
              this.invocationId,
              this.state.attempt,
              Math.max(0, updatedAt - this.state.startedAt),
              this.lastErrorAttempt,
            ),
          }
        : {}),
    };
    return { type: 'app_server.startup_recovery', startupRecovery: this.state };
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Cancel one connection/request; late connections are released rather than terminating their host. */
export function withCodexStartupCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  releaseLate?: (value: T) => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    let stopped = signal.aborted;
    const onAbort = () => {
      stopped = true;
      reject(signal.reason);
    };
    if (stopped) reject(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (stopped) void releaseLate?.(value).catch(() => {});
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
