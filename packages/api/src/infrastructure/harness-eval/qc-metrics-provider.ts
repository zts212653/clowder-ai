/**
 * F253 Phase C — QC Metrics Provider (AC-C3).
 *
 * Aggregates per-PR quality data into 4 eval:qc metrics:
 * 1. Finding Yield: average actionable findings per review
 * 2. False Positive Rate: findings rejected by author / total findings
 * 3. Reviewer Delta: formal reviewer new findings vs fresh-context coverage
 * 4. Post-Merge Bug Rate: hotfixes within 14-day window per merged PR
 *
 * Phase C bootstrap: returns zero-baseline metrics (no runtime data
 * source wired yet). The eval cat reads these as "no data yet" and
 * produces a keep_observe verdict. Live data sources will be wired
 * in future phases when review telemetry events are available.
 */

export interface QcMetricsSnapshot {
  findingYield: number;
  falsePositiveRate: number;
  reviewerDelta: number;
  postMergeBugRate: number;
  prCount: number;
  windowDays: number;
}

export interface QcMetricsSelector {
  kind: 'qc-metrics-rollup';
  windowStartMs: number;
  windowEndMs: number;
}

/**
 * Resolve QC metrics for the given window.
 *
 * Phase C bootstrap: returns zero-baseline snapshot. The structure
 * is real (eval cat can read it), but values are zero because no
 * review telemetry source is wired yet.
 */
export function resolveQcMetrics(selector: QcMetricsSelector): QcMetricsSnapshot {
  const windowMs = selector.windowEndMs - selector.windowStartMs;
  const windowDays = Math.round(windowMs / (24 * 3600 * 1000));

  return {
    findingYield: 0,
    falsePositiveRate: 0,
    reviewerDelta: 0,
    postMergeBugRate: 0,
    prCount: 0,
    windowDays,
  };
}
