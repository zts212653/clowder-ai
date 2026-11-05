import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';

interface TurnExecutionStartupReconcilerDeps {
  store: Pick<ITurnExecutionStore, 'attestProviderTeardownBefore' | 'interruptRunningBefore' | 'listResponsePending'>;
  now?: () => number;
  /**
   * F117 KD-21: ends an ended turn's response R with the body its draft streamed and clears the
   * turn from the response-pending ledger. A turn whose settlement throws stays in the ledger.
   */
  settleEndedTurnResponse?: (turn: TurnExecutionRecord) => Promise<unknown>;
}

export interface TurnExecutionStartupReconcileResult {
  /** Prior-Host providers whose stop is proven by the completed process-owner reap. */
  providerStopAttestationCount: number;
  interruptedCount: number;
  invocationIds: string[];
  /** Ended turns of earlier processes whose response R settled in this pass. */
  settledResponseCount: number;
  /** Ended turns whose response R did not settle; they stay in the ledger for the next startup. */
  responseSettlementFailures: Array<{ invocationId: string; error: string }>;
  /** The response-pending ledger could not be read, so no response settled in this pass. */
  responseLedgerError?: string;
  reconciledAt: number;
}

interface ListenBeforeTurnExecutionRecoveryDeps<T> {
  listen: () => Promise<T>;
  recover: () => Promise<unknown>;
  onRecoveryError: (error: unknown) => void;
}

/**
 * A durable restart terminal may only be written after this process proves it
 * owns both the Redis namespace and the HTTP listener. The caller also completes
 * process-owner reaping before listen, so recovery may attest prior-Host provider stop.
 * Recovery is best-effort once listening succeeds; a recovery failure must not
 * tear down a healthy API.
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

export type ResponseSettlementPass = Pick<
  TurnExecutionStartupReconcileResult,
  'settledResponseCount' | 'responseSettlementFailures' | 'responseLedgerError'
>;

export class TurnExecutionStartupReconciler {
  private readonly store: TurnExecutionStartupReconcilerDeps['store'];
  private readonly now: () => number;
  private readonly settleEndedTurnResponse: TurnExecutionStartupReconcilerDeps['settleEndedTurnResponse'];

  constructor(deps: TurnExecutionStartupReconcilerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.settleEndedTurnResponse = deps.settleEndedTurnResponse;
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
    const stoppedProviders = await this.store.attestProviderTeardownBefore(exclusiveCutoffStartedAt, reconciledAt);
    const interrupted = await this.store.interruptRunningBefore(exclusiveCutoffStartedAt, {
      endedAt: reconciledAt,
      terminalReason: 'process_restart',
    });
    const settlement = await this.settleEndedTurnResponses(input);
    return {
      providerStopAttestationCount: stoppedProviders.length,
      interruptedCount: interrupted.length,
      invocationIds: interrupted.map((record) => record.invocationId),
      ...settlement,
      reconciledAt,
    };
  }

  /**
   * Settles every ended turn of an earlier process whose R is unconfirmed: the turns interrupted
   * just now, and any a failed settlement or a crash between the turn's terminal write and its R
   * commit left behind. A turn this process started may still have a live route about to commit R.
   * Only ended turns are touched, so this is safe even when external owner liveness is unknown.
   * One response that cannot settle must neither strand the others nor fail startup recovery.
   */
  async settleEndedTurnResponses(input: { processStartedAt: number }): Promise<ResponseSettlementPass> {
    const exclusiveCutoffStartedAt = input.processStartedAt + 1;
    const pass: ResponseSettlementPass = { settledResponseCount: 0, responseSettlementFailures: [] };
    if (!this.settleEndedTurnResponse) return pass;
    let pending: readonly TurnExecutionRecord[];
    try {
      pending = await this.store.listResponsePending();
    } catch (error) {
      return { ...pass, responseLedgerError: String(error) };
    }
    for (const turn of pending) {
      if (turn.startedAt >= exclusiveCutoffStartedAt) continue;
      try {
        await this.settleEndedTurnResponse(turn);
        pass.settledResponseCount += 1;
      } catch (error) {
        pass.responseSettlementFailures.push({ invocationId: turn.invocationId, error: String(error) });
      }
    }
    return pass;
  }
}
