import type { PawFeelSignalScanCursorV1 } from '../event-log.js';
import type { PawFeelDispositionService } from '../service.js';

export interface PawFeelBlockerReconciliationResult {
  scanCalls: number;
  cycleComplete: boolean;
  counts: {
    scanned: number;
    stable: number;
    reopened: number;
    conflicted: number;
    deferred: number;
    failed: number;
  };
}

export class PawFeelBlockerReconciliationPageError extends Error {
  constructor(
    readonly result: PawFeelBlockerReconciliationResult,
    readonly firstFailure: unknown,
  ) {
    super(firstFailure instanceof Error ? firstFailure.message : String(firstFailure));
    this.name = 'PawFeelBlockerReconciliationPageError';
  }
}

export interface PawFeelBlockerReconcilerOptions {
  service: Pick<PawFeelDispositionService, 'scanSignalIds' | 'reconcileBlocker'>;
  limit?: number;
}

export class PawFeelBlockerReconciler {
  private readonly limit: number;
  private cursor: PawFeelSignalScanCursorV1 | undefined;

  constructor(private readonly options: PawFeelBlockerReconcilerOptions) {
    this.limit = options.limit ?? 50;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 50) {
      throw new Error('paw-feel blocker reconciliation limit must be between 1 and 50');
    }
  }

  async reconcile(): Promise<PawFeelBlockerReconciliationResult> {
    const counts = { scanned: 0, stable: 0, reopened: 0, conflicted: 0, deferred: 0, failed: 0 };
    const page = await this.options.service.scanSignalIds(this.cursor, this.limit);
    let firstFailure: unknown;
    let pageFailed = false;
    for (const signalId of page.signalIds) {
      try {
        const outcome = await this.options.service.reconcileBlocker(signalId);
        if (outcome === 'ignored') continue;
        counts.scanned += 1;
        counts[outcome] += 1;
      } catch (error) {
        if (!pageFailed) firstFailure = error;
        pageFailed = true;
        counts.scanned += 1;
        counts.failed += 1;
      }
    }
    const result = { scanCalls: page.scanCalls, cycleComplete: !page.nextCursor, counts };
    if (pageFailed) throw new PawFeelBlockerReconciliationPageError({ ...result, cycleComplete: false }, firstFailure);
    this.cursor = page.nextCursor;
    return result;
  }
}
