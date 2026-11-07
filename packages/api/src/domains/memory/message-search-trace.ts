/** Current source-search phases only. Retired provider events cannot re-enter the log surface. */
const phases = new Set([
  'visibility',
  'source-admission',
  'retrieval',
  'canonical-projection',
  'decision-sources',
  'final-revalidation',
]);

export function privateMessageSearchTrace(trace: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    if (typeof trace.phase !== 'string' || !phases.has(trace.phase)) return;
    const result: Record<string, unknown> = { phase: trace.phase };
    for (const key of ['elapsedMs', 'phaseElapsedMs']) {
      const value = trace[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    }
    return result;
  } catch {
    return;
  } // Hostile getter/observer must not own result/error semantics.
}
