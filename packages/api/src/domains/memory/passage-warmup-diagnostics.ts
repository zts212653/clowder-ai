import { randomUUID } from 'node:crypto';

/** One existing warmup Promise, not a backlog/coverage measurement or persistent ledger. */
export class PassageWarmupDiagnostics {
  readonly runId = randomUUID();
  private readonly started = performance.now();
  outcome: 'fulfilled' | 'rejected' | 'retired' = 'fulfilled';
  stopReason = 'scan-exhausted';
  scanExhausted = false;
  pagesRead = 0;
  metadataRows = 0;
  missingBodies = 0;
  returnedBatches = 0;
  committedVectors = 0;
  sourceChanged = 0;
  batchFailures = 0;

  stop(outcome: 'rejected' | 'retired', reason: string) {
    if (this.outcome !== 'fulfilled') return; // Keep the first observed terminal boundary.
    this.outcome = outcome;
    this.stopReason = reason;
  }

  finish() {
    try {
      console.info('[memory] passage warmup outcome', {
        runId: this.runId,
        outcome: this.outcome,
        stopReason: this.stopReason,
        elapsedMs: performance.now() - this.started,
        scanExhausted: this.scanExhausted,
        pagesRead: this.pagesRead,
        metadataRows: this.metadataRows,
        missingBodies: this.missingBodies,
        returnedBatches: this.returnedBatches,
        committedVectors: this.committedVectors,
        sourceChanged: this.sourceChanged,
        batchFailures: this.batchFailures,
      });
    } catch {
      /* Optional logging cannot affect fail-open warmup or cleanup. */
    }
  }
}
