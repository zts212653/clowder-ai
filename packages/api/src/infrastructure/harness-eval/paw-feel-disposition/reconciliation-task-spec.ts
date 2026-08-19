import type { TaskSpec_P1 } from '../../scheduler/types.js';
import {
  pawFeelReconciliationDiscovered,
  pawFeelReconciliationDuplicates,
  pawFeelReconciliationDuration,
  pawFeelReconciliationLag,
  pawFeelReconciliationScannedMessages,
  pawFeelReconciliationUnavailable,
} from '../../telemetry/instruments.js';
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
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  metrics?: PawFeelReconciliationMetrics;
  intervalMs?: number;
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
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          metrics.recordUnavailable(reason);
          options.log.warn({ reason }, '[paw-feel-disposition] reconciliation unavailable');
          throw error;
        }
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
