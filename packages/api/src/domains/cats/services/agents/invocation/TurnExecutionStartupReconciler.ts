import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';

interface TurnExecutionStartupReconcilerDeps {
  store: ITurnExecutionStore;
  now?: () => number;
}

export interface TurnExecutionStartupReconcileResult {
  interruptedCount: number;
  invocationIds: string[];
  reconciledAt: number;
}

interface ListenBeforeTurnExecutionRecoveryDeps<T> {
  listen: () => Promise<T>;
  recover: () => Promise<unknown>;
  onRecoveryError: (error: unknown) => void;
}

/**
 * A durable restart terminal may only be written after this process proves it
 * owns both the Redis namespace and the HTTP listener. Recovery is best-effort
 * once listening succeeds; a recovery failure must not tear down a healthy API.
 */
export async function listenBeforeTurnExecutionRecovery<T>(deps: ListenBeforeTurnExecutionRecoveryDeps<T>): Promise<T> {
  const address = await deps.listen();
  try {
    await deps.recover();
  } catch (error) {
    deps.onRecoveryError(error);
  }
  return address;
}

export class TurnExecutionStartupReconciler {
  private readonly store: ITurnExecutionStore;
  private readonly now: () => number;

  constructor(deps: TurnExecutionStartupReconcilerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  async reconcile(input: { processStartedAt: number }): Promise<TurnExecutionStartupReconcileResult> {
    if (!Number.isFinite(input.processStartedAt) || input.processStartedAt < 0) {
      throw new Error('processStartedAt must be a finite non-negative number');
    }
    const reconciledAt = this.now();
    // A persisted child stamped in the same millisecond as process start still
    // belongs to the previous process. The store takes an exclusive cutoff; +1
    // includes that exact millisecond without changing its reusable contract.
    const exclusiveCutoffStartedAt = input.processStartedAt + 1;
    const interrupted = await this.store.interruptRunningBefore(exclusiveCutoffStartedAt, {
      endedAt: reconciledAt,
      terminalReason: 'process_restart',
    });
    return {
      interruptedCount: interrupted.length,
      invocationIds: interrupted.map((record) => record.invocationId),
      reconciledAt,
    };
  }
}
