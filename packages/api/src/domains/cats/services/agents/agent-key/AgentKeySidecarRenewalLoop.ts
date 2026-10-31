const DEFAULT_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AgentKeySidecarRenewalLoopOptions {
  readonly reconcile: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
}

export interface NamedSidecarReconciliation {
  readonly name: string;
  readonly reconcile: () => Promise<void>;
}

export async function reconcileSidecarsIndependently(
  reconciliations: readonly NamedSidecarReconciliation[],
): Promise<void> {
  const results = await Promise.allSettled(
    reconciliations.map(({ reconcile }) => Promise.resolve().then(() => reconcile())),
  );
  const failures = results.flatMap((result, index) => {
    const reconciliation = reconciliations[index];
    if (result.status !== 'rejected' || !reconciliation) return [];
    return [{ name: reconciliation.name, error: result.reason }];
  });
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `agent-key sidecar renewal failed: ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
}

/**
 * Daily, serialized reconciliation for file-backed agent keys.
 *
 * Startup reconciliation alone is insufficient because the registry TTL is
 * finite while an API process may remain alive indefinitely. Overlapping
 * ticks coalesce so a slow Redis/filesystem round cannot rotate twice.
 */
export class AgentKeySidecarRenewalLoop {
  private readonly intervalMs: number;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: AgentKeySidecarRenewalLoopOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('agent-key sidecar renewal interval must be a positive integer');
    }
  }

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = Promise.resolve()
      .then(() => this.options.reconcile())
      .catch((error: unknown) => {
        this.options.onError(error);
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }
}
