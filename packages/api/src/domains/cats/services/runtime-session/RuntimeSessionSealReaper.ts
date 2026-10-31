import type { ISessionSealer, SealReason } from '../session/SessionSealer.js';
import type { RuntimeSessionDrainResult, RuntimeSessionMetadata } from './RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from './RuntimeSessionStore.js';

export type RuntimeSessionSealReaperDrainResult =
  | {
      ok: true;
      drainResult: Extract<RuntimeSessionDrainResult, 'complete' | 'best_effort_quiet_window'>;
      lastObservedStepCount: number;
    }
  | {
      ok: false;
      drainResult: Extract<RuntimeSessionDrainResult, 'best_effort_quiet_window' | 'skipped_runtime_unreachable'>;
      reason: string;
      lastObservedStepCount?: number;
    };

export interface RuntimeSessionSealReaperRunResult {
  scanned: number;
  drained: number;
  sealed: number;
  pending: number;
  skippedMaxRetries: number;
  failed: number;
}

export interface RuntimeSessionSealReaperOptions {
  runtimeSessionStore: IRuntimeSessionStore;
  sessionSealer: ISessionSealer;
  drainRuntimeSession: (record: RuntimeSessionMetadata) => Promise<RuntimeSessionSealReaperDrainResult>;
  maxRetries?: number;
  now?: () => number;
}

type RuntimeSessionSealReaperIntervalHandle = ReturnType<typeof setInterval>;

export interface SerializedRuntimeSessionSealReaperIntervalOptions {
  runtimeSessionSealReaper: Pick<RuntimeSessionSealReaper, 'runOnce'>;
  intervalMs: number;
  onResult?: (result: RuntimeSessionSealReaperRunResult) => void;
  onError?: (err: unknown) => void;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RuntimeSessionSealReaperIntervalHandle;
}

const DEFAULT_MAX_RETRIES = 5;

export class RuntimeSessionSealReaper {
  private readonly runtimeSessionStore: IRuntimeSessionStore;
  private readonly sessionSealer: ISessionSealer;
  private readonly drainRuntimeSession: (
    record: RuntimeSessionMetadata,
  ) => Promise<RuntimeSessionSealReaperDrainResult>;
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(options: RuntimeSessionSealReaperOptions) {
    this.runtimeSessionStore = options.runtimeSessionStore;
    this.sessionSealer = options.sessionSealer;
    this.drainRuntimeSession = options.drainRuntimeSession;
    this.maxRetries =
      Number.isSafeInteger(options.maxRetries) && (options.maxRetries ?? 0) > 0
        ? Math.floor(options.maxRetries as number)
        : DEFAULT_MAX_RETRIES;
    this.now = options.now ?? (() => Date.now());
  }

  async runOnce(): Promise<RuntimeSessionSealReaperRunResult> {
    const records = await this.runtimeSessionStore.listByLifecycleState('runtime_seal_pending');
    const result = emptyRunResult(records.length);

    for (const record of records) {
      addRunResult(result, await this.processRecord(record));
    }

    return result;
  }

  private async processRecord(record: RuntimeSessionMetadata): Promise<RuntimeSessionSealReaperRunResult> {
    const result = emptyRunResult();
    const retryCount = record.lifecycle.retryCount ?? 0;
    if (retryCount >= this.maxRetries) {
      result.skippedMaxRetries = 1;
      return result;
    }

    const drain = await this.drainRecord(record);
    result.drained = 1;

    try {
      if (drain.ok && drain.drainResult === 'complete') {
        await this.requestSessionSeal(record.sessionId, record.lifecycle.sealReason ?? 'runtime_error_reset');
        await this.markRuntimeSealed(record, drain.drainResult, record.lifecycle.sealReason);
        result.sealed = 1;
        return result;
      }

      const incompleteDrain = toIncompleteDrain(drain);
      await this.recordDrainFailure(record, incompleteDrain);

      if (incompleteDrain.drainResult === 'skipped_runtime_unreachable') {
        await this.requestSessionSeal(record.sessionId, 'runtime_disconnected');
        await this.markRuntimeSealed(
          record,
          incompleteDrain.drainResult,
          'runtime_disconnected',
          incompleteDrain.reason,
        );
        result.sealed = 1;
        return result;
      }

      result.pending = 1;
      return result;
    } catch (err) {
      await this.recordProcessingFailure(record, drain, err).catch(() => {});
      result.failed = 1;
      return result;
    }
  }

  private async drainRecord(record: RuntimeSessionMetadata): Promise<RuntimeSessionSealReaperDrainResult> {
    try {
      return await this.drainRuntimeSession(record);
    } catch (err) {
      return {
        ok: false,
        drainResult: 'skipped_runtime_unreachable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async recordDrainFailure(
    record: RuntimeSessionMetadata,
    drain: Extract<RuntimeSessionSealReaperDrainResult, { ok: false }>,
  ): Promise<void> {
    const now = this.now();
    await this.runtimeSessionStore.updateLifecycle(record.sessionId, {
      state: 'runtime_seal_pending',
      drainResult: drain.drainResult,
      retryCount: (record.lifecycle.retryCount ?? 0) + 1,
      lastRetryAt: now,
      lastObservedAt: now,
      lastFailureReason: drain.reason,
    });
  }

  private async recordProcessingFailure(
    record: RuntimeSessionMetadata,
    drain: RuntimeSessionSealReaperDrainResult,
    err: unknown,
  ): Promise<void> {
    const now = this.now();
    await this.runtimeSessionStore.updateLifecycle(record.sessionId, {
      state: 'runtime_seal_pending',
      drainResult: drain.drainResult,
      retryCount: (record.lifecycle.retryCount ?? 0) + 1,
      lastRetryAt: now,
      lastObservedAt: now,
      lastFailureReason: formatProcessingFailureReason(err),
    });
  }

  private async markRuntimeSealed(
    record: RuntimeSessionMetadata,
    drainResult: RuntimeSessionDrainResult,
    sealReason?: string,
    lastFailureReason?: string,
  ): Promise<void> {
    const now = this.now();
    await this.runtimeSessionStore.updateLifecycle(record.sessionId, {
      state: 'sealed',
      drainResult,
      lastObservedAt: now,
      ...(sealReason ? { sealReason } : {}),
      ...(lastFailureReason ? { lastFailureReason } : {}),
    });
  }

  private async requestSessionSeal(sessionId: string, reason: SealReason): Promise<void> {
    const seal = await this.sessionSealer.requestSeal({ sessionId, reason });
    if (seal.accepted || seal.status === 'sealing') {
      await this.sessionSealer.finalize({ sessionId });
      return;
    }
    if (seal.status === 'sealed') return;
    throw new Error(`session seal request was not accepted; status=${seal.status}`);
  }
}

export function startSerializedRuntimeSessionSealReaperInterval(
  options: SerializedRuntimeSessionSealReaperIntervalOptions,
): RuntimeSessionSealReaperIntervalHandle {
  let sweepInFlight = false;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  return setIntervalFn(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void options.runtimeSessionSealReaper
      .runOnce()
      .then((result) => {
        options.onResult?.(result);
      })
      .catch((err) => {
        options.onError?.(err);
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, options.intervalMs);
}

function emptyRunResult(scanned = 0): RuntimeSessionSealReaperRunResult {
  return {
    scanned,
    drained: 0,
    sealed: 0,
    pending: 0,
    skippedMaxRetries: 0,
    failed: 0,
  };
}

function addRunResult(target: RuntimeSessionSealReaperRunResult, delta: RuntimeSessionSealReaperRunResult): void {
  target.drained += delta.drained;
  target.sealed += delta.sealed;
  target.pending += delta.pending;
  target.skippedMaxRetries += delta.skippedMaxRetries;
  target.failed += delta.failed;
}

function toIncompleteDrain(
  drain: RuntimeSessionSealReaperDrainResult,
): Extract<RuntimeSessionSealReaperDrainResult, { ok: false }> {
  if (!drain.ok) return drain;
  return {
    ok: false,
    drainResult: 'best_effort_quiet_window',
    reason: `runtime drain returned non-terminal ${drain.drainResult}`,
    lastObservedStepCount: drain.lastObservedStepCount,
  };
}

function formatProcessingFailureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
