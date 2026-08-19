import type { ComponentHealth, TelemetryGap } from './f167-eval.js';

const METRIC_PREFIX = 'cat_cafe_a2a_routing_event_wait_';
const TERMINAL_RELEASE_METRIC_PREFIX = 'cat_cafe_a2a_routing_terminal_release_';

function normalizePromKey(raw: string): string {
  return raw.replace(/\{[^}]*\}/, '').replace(/_total$/, '');
}

function sumMetricByPrefix(metrics: Record<string, number>, prefix: string): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (normalizePromKey(key) !== prefix) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function rejectionReason(key: string): string | null {
  const match = key.match(/(?:^|[,{}])routing_event_wait_reason="([^"]+)"/);
  return match?.[1] ?? null;
}

function sumRejectedReasons(metrics: Record<string, number>, reasons: ReadonlySet<string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (normalizePromKey(key) !== `${METRIC_PREFIX}rejected`) continue;
    const reason = rejectionReason(key);
    if (reason && reasons.has(reason)) total += value;
  }
  return total;
}

const STALE_REASONS = new Set(['task_done', 'invocation_mismatch']);
const UNRELATED_REASONS = new Set(['owner_mismatch', 'thread_mismatch', 'subject_mismatch']);
const UNCOVERED_REASONS = new Set(['coverage_unconfirmed', 'intent_mismatch']);
const QUERY_FAILED_REASONS = new Set(['query_failed', 'state_source_unavailable']);
const OTHER_REASONS = new Set(['missing_invocation', 'no_candidate', 'proof_invalid']);

/** F177 Phase J runtime verdict component, consumed by the longitudinal F167 eval. */
export function buildEventBackedRoutingExitEval(metrics: Record<string, number>): ComponentHealth {
  const bypass = sumMetricByPrefix(metrics, `${METRIC_PREFIX}bypass`);
  const rejected = sumMetricByPrefix(metrics, `${METRIC_PREFIX}rejected`);
  const falseBypass = sumMetricByPrefix(metrics, `${METRIC_PREFIX}false_bypass`);
  const redundantHoldPrevented = sumMetricByPrefix(metrics, `${METRIC_PREFIX}redundant_hold_prevented`);
  const terminalCleanStop = sumMetricByPrefix(metrics, `${TERMINAL_RELEASE_METRIC_PREFIX}clean_stop`);
  const terminalRemedial = sumMetricByPrefix(metrics, `${TERMINAL_RELEASE_METRIC_PREFIX}remedial`);

  const activationCounts: Record<string, number | null> = {};
  if (bypass !== null) activationCounts['event_wait.bypass_total'] = bypass;
  if (rejected !== null) {
    activationCounts['event_wait.rejected_total'] = rejected;
    activationCounts['event_wait.rejected_stale_total'] = sumRejectedReasons(metrics, STALE_REASONS);
    activationCounts['event_wait.rejected_unrelated_total'] = sumRejectedReasons(metrics, UNRELATED_REASONS);
    activationCounts['event_wait.rejected_uncovered_total'] = sumRejectedReasons(metrics, UNCOVERED_REASONS);
    activationCounts['event_wait.rejected_query_failed_total'] = sumRejectedReasons(metrics, QUERY_FAILED_REASONS);
    activationCounts['event_wait.rejected_other_total'] = sumRejectedReasons(metrics, OTHER_REASONS);
  }
  if (redundantHoldPrevented !== null) {
    activationCounts['event_wait.redundant_hold_prevented_total'] = redundantHoldPrevented;
  }
  if (terminalCleanStop !== null) activationCounts['terminal_release.clean_stop_total'] = terminalCleanStop;

  const frictionCounts: Record<string, number | null> = {};
  if (falseBypass !== null) frictionCounts['event_wait.false_bypass_total'] = falseBypass;
  if (terminalRemedial !== null) frictionCounts['terminal_release.remedial_total'] = terminalRemedial;

  const required: Array<[string, number | null, string]> = [
    ['event_wait.bypass_total', bypass, 'Cannot measure verified event-backed routing exits'],
    ['event_wait.rejected_total', rejected, 'Cannot audit stale or unrelated candidates rejected fail-closed'],
    ['event_wait.false_bypass_total', falseBypass, 'Cannot enforce the zero-tolerance false-bypass invariant'],
    [
      'event_wait.redundant_hold_prevented_total',
      redundantHoldPrevented,
      'Cannot measure redundant wait outlets prevented by callback coverage',
    ],
    ['terminal_release.clean_stop_total', terminalCleanStop, 'Cannot measure structured terminal clean stops'],
    ['terminal_release.remedial_total', terminalRemedial, 'Cannot detect terminal releases sent through remedial'],
  ];
  const telemetryGaps: TelemetryGap[] = required
    .filter(([, value]) => value === null)
    .map(([metric, , impact]) => ({ metric, reason: 'no_counter', impact }));

  return {
    componentId: 'event-backed-routing-exit',
    componentName: 'routing guard (verified event-backed exit)',
    activationCounts,
    frictionCounts,
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: telemetryGaps.length === 0 ? 'medium' : 'no-data',
    telemetryGaps,
  };
}
