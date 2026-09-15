import type { TaskSpec_P1 } from '../../scheduler/types.js';
import {
  pawFeelReconciliationDiscovered,
  pawFeelReconciliationDuplicates,
  pawFeelReconciliationDuration,
  pawFeelReconciliationLag,
  pawFeelReconciliationScannedMessages,
  pawFeelReconciliationUnavailable,
} from '../../telemetry/instruments.js';
import {
  type PawFeelBlockerReconciler,
  PawFeelBlockerReconciliationPageError,
} from './blocker-recovery/blocker-reconciler.js';
import type { PawFeelDispositionReconciler, PawFeelReconciliationResult } from './reconciler.js';

interface PawFeelReconciliationSignal {
  requested: 'auto';
}

export interface PawFeelReconciliationMetrics {
  record(result: PawFeelReconciliationResult): void;
  recordUnavailable(reason: string): void;
}

const defaultMetrics: PawFeelReconciliationMetrics = {
  record(result) {
    pawFeelReconciliationDuration.record(result.durationMs);
    pawFeelReconciliationScannedMessages.record(result.scannedMessages);
    pawFeelReconciliationDiscovered.add(result.discoveredSignals);
    pawFeelReconciliationDuplicates.add(result.duplicateSignals);
    pawFeelReconciliationLag.record(result.lagMs);
  },
  recordUnavailable() {
    pawFeelReconciliationUnavailable.add(1);
  },
};

export interface PawFeelReconciliationTaskSpecOptions {
  reconciler: Pick<PawFeelDispositionReconciler, 'run'>;
  blockerReconciler?: Pick<PawFeelBlockerReconciler, 'reconcile'>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  metrics?: PawFeelReconciliationMetrics;
  intervalMs?: number;
}

interface ReconciliationFailure {
  error: unknown;
}

async function runCoverageReconciliation(
  options: PawFeelReconciliationTaskSpecOptions,
  metrics: PawFeelReconciliationMetrics,
): Promise<ReconciliationFailure | undefined> {
  try {
    const result = await options.reconciler.run();
    metrics.record(result);
    options.log.info(
      {
        mode: result.mode,
        durationMs: result.durationMs,
        scannedMessages: result.scannedMessages,
        canonicalSignals: result.canonicalSignals,
        discoveredSignals: result.discoveredSignals,
        duplicateSignals: result.duplicateSignals,
        lagMs: result.lagMs,
      },
      '[paw-feel-disposition] reconciliation complete',
    );
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    metrics.recordUnavailable(reason);
    options.log.warn({ reason }, '[paw-feel-disposition] reconciliation unavailable');
    return { error };
  }
}

async function runBlockerReconciliation(
  options: PawFeelReconciliationTaskSpecOptions,
): Promise<ReconciliationFailure | undefined> {
  if (!options.blockerReconciler) return undefined;
  try {
    const result = await options.blockerReconciler.reconcile();
    options.log.info(
      { ...result.counts, scanCalls: result.scanCalls, cycleComplete: result.cycleComplete },
      '[paw-feel-disposition] blocker reconciliation page complete',
    );
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.log.warn(
      {
        reason,
        ...(error instanceof PawFeelBlockerReconciliationPageError
          ? {
              ...error.result.counts,
              scanCalls: error.result.scanCalls,
              cycleComplete: error.result.cycleComplete,
            }
          : {}),
      },
      '[paw-feel-disposition] blocker reconciliation unavailable',
    );
    return { error };
  }
}

export function createPawFeelReconciliationTaskSpec(
  options: PawFeelReconciliationTaskSpecOptions,
): TaskSpec_P1<PawFeelReconciliationSignal> {
  const metrics = options.metrics ?? defaultMetrics;
  return {
    id: 'paw-feel-disposition-reconciler',
    profile: 'poller',
    trigger: { type: 'interval', ms: options.intervalMs ?? 15 * 60_000 },
    admission: {
      async gate() {
        return {
          run: true,
          workItems: [
            {
              subjectKey: 'paw-feel-disposition-coverage',
              signal: { requested: 'auto' },
            },
          ],
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute() {
        const blockerFailure = await runBlockerReconciliation(options);
        const coverageFailure = await runCoverageReconciliation(options, metrics);
        if (blockerFailure && !coverageFailure) {
          const reason =
            blockerFailure.error instanceof Error ? blockerFailure.error.message : String(blockerFailure.error);
          metrics.recordUnavailable(reason);
        }
        const failure = coverageFailure ?? blockerFailure;
        if (failure) throw failure.error;
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    display: {
      label: 'Paw-Feel Disposition Reconciler',
      category: 'system',
      description: 'Proves full and overlap coverage for the cat-authored paw-feel inbox',
      subjectKind: 'none',
    },
  };
}
