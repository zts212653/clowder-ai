/** Request-local lifecycle evidence only: no query, identity, body, prompt or raw provider event. */
export function observeQueryQualification() {
  const batches: Array<{
    batchIndex: number;
    rows: number;
    bodyChars: number;
    remainingMs: number;
    stage: string;
    runMs?: number;
    abortAfterMs?: number;
    cleanupAfterAbortMs?: number;
    outcome?: 'completed' | 'failed' | 'aborted';
  }> = [];
  let nativeLaunches = 0;
  let costReports = 0;
  let reportedCostUsd = 0;
  const snapshot = () => ({
    runnerCalls: batches.length,
    nativeLaunches,
    costReports,
    reportedCostUsd: costReports ? reportedCostUsd : null,
    batches: batches.map((batch) => ({ ...batch })),
  });
  return {
    snapshot,
    start(rows: number, bodyChars: number, deadlineAt: number, onTrace?: (event: Record<string, unknown>) => void) {
      const entered = performance.now();
      const batch: (typeof batches)[number] = {
        batchIndex: batches.length,
        rows,
        bodyChars,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
        stage: 'runner',
      };
      batches.push(batch);
      return {
        trace(event: Record<string, unknown>) {
          if (
            [
              'native-prepared',
              'native-launch',
              'native-init',
              'native-response',
              'native-output',
              'native-usage',
              'native-completed',
            ].includes(String(event.phase))
          )
            batch.stage = String(event.phase);
          if (event.phase === 'native-launch') nativeLaunches++;
          if (
            event.phase === 'native-usage' &&
            typeof event.costUsd === 'number' &&
            Number.isFinite(event.costUsd) &&
            event.costUsd >= 0
          ) {
            costReports++;
            reportedCostUsd += event.costUsd;
          }
          onTrace?.({ ...event, batchIndex: batch.batchIndex });
        },
        abort() {
          batch.abortAfterMs ??= Math.max(0, performance.now() - entered);
        },
        finish(aborted: boolean, failed: boolean) {
          batch.runMs = Math.max(0, performance.now() - entered);
          if (batch.abortAfterMs !== undefined)
            batch.cleanupAfterAbortMs = Math.max(0, batch.runMs - batch.abortAfterMs);
          batch.outcome = aborted ? 'aborted' : failed ? 'failed' : 'completed';
        },
      };
    },
    attach(error: unknown) {
      if (!(error instanceof Error)) return;
      try {
        Object.assign(error, {
          messageSearchQualification: snapshot(),
        });
      } catch {
        /* Diagnostics cannot replace a frozen/hostile original error. */
      }
    },
  };
}
