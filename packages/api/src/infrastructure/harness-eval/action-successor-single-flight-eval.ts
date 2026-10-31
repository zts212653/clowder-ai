import type { ComponentHealth } from './f167-eval.js';

function metricName(raw: string): string {
  return raw.replace(/\{[^}]*\}/, '');
}

function labelValue(raw: string, label: string): string | undefined {
  const labels = /\{([^}]*)\}/.exec(raw)?.[1];
  if (!labels) return undefined;
  return new RegExp(`(?:^|,)${label}="([^"]*)"`).exec(labels)?.[1];
}

function sumMetric(metrics: Record<string, number>, expected: string): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (metricName(key).replace(/_total$/, '') !== expected) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function sumHistogramSeries(
  metrics: Record<string, number>,
  expected: string,
  labels: Record<string, string>,
): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (metricName(key) !== expected) continue;
    if (Object.entries(labels).some(([name, expectedValue]) => labelValue(key, name) !== expectedValue)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function calculateCounterRate(total: number | null, matching: number | null): number | null {
  if (total == null || matching == null) return null;
  return total === 0 ? 0 : matching / total;
}

function calculateEffectiveSingleViolations(
  singleCount: number | null,
  singleSum: number | null,
  actionCount: number | null,
  parallelCount: number | null,
  hasCounters: boolean,
): number | null {
  // Non-idle proof: single-mode admissions observed, derive excess concurrency mass.
  // `singleSum - singleCount` = accumulated holder count above the single-target
  // invariant of 1. Every single-mode admission records `lease.holderCatIds.length`;
  // schema enforces exactly 1 target for `mode='single'`, so healthy runs have
  // sum == count (mass=0). Any obs > 1 lifts sum above count. Uses `_sum + _count`
  // (always emitted with the histogram) instead of `_bucket{le="1"}`, which OTel
  // default histogram boundaries [0, 5, 10, 25, ...] omit — the previous `le="1"`
  // dependency caused a non-idle window to report a false `no_counter` gap
  // (07-15 verdict `2026-07-15-eval-a2a-successor-histogram-bucket-fix`).
  if (singleCount != null && singleSum != null) return Math.max(0, singleSum - singleCount);
  // Idle recognition — proof of "no admissions occurred" must be SYMMETRIC across
  // both admission histograms. `admitted()` in ActionSuccessorAdmissionService issues
  // two independent record() calls (`successorUniqueCatsInvokedPerAction` and
  // `successorConcurrentSuccessors`), so a real admit lights up both, and a real
  // idle window darkens both. Any asymmetric signal (one histogram present, the
  // other absent) implies partial emission failure — must NOT be washed into clean.
  //
  // - Cold-idle (07-18 verdict `2026-07-18-eval-a2a-successor-cold-idle-gap-v3`):
  //   both admission histograms fully absent (no _count/_sum/_bucket for either),
  //   lifecycle counters warm at 0 → hasCounters proves aliveness → return 0.
  // - Warm-idle (testing-side path): actionCount warmed at 0, no concurrent series.
  //
  // Any partial signal (07-18 R2 P1 by @gpt52) — actionCount absent while
  // singleCount/parallelCount present, or actionCount present while both concurrent
  // labels absent — indicates OTel wiring dropped half of the dual record. Flag gap.
  const admissionHistogramsFullyAbsent = actionCount == null && singleCount == null && parallelCount == null;
  if (admissionHistogramsFullyAbsent && hasCounters) return 0;
  if (actionCount === 0 && singleCount == null && parallelCount == null) return 0;
  return null;
}

function observedCounts(
  hasCounters: boolean,
  counts: ComponentHealth['activationCounts'],
): ComponentHealth['activationCounts'] {
  return hasCounters ? counts : {};
}

function buildTelemetryGaps(
  hasCounters: boolean,
  observations: ReadonlyArray<{ metric: string; value: number | null; impact: string }>,
  singleTargetMultiMentionRate: number | null,
): ComponentHealth['telemetryGaps'] {
  if (!hasCounters) {
    return [
      {
        metric: 'successor.concurrent_successors',
        reason: 'no_counter',
        impact: 'Cannot observe action successor admission or terminal-response suppression',
      },
    ];
  }
  const gaps: ComponentHealth['telemetryGaps'] = [];
  for (const observation of observations) {
    if (observation.value != null) continue;
    gaps.push({ metric: observation.metric, reason: 'no_counter', impact: observation.impact });
  }
  if (singleTargetMultiMentionRate == null) {
    gaps.push({
      metric: 'successor.single_target_multi_mention_rate',
      reason: 'no_counter',
      impact: 'Cannot calculate carrier migration rate until both numerator and denominator counters are warm',
    });
  }
  return gaps;
}

/** F167 Phase S: ADR-031 eval projection for action successor cardinality. */
export function buildActionSuccessorSingleFlight(metrics: Record<string, number>): ComponentHealth {
  const uniqueCats = sumMetric(metrics, 'cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum');
  const actionCount = sumMetric(metrics, 'cat_cafe_a2a_successor_unique_cats_invoked_per_action_count');
  const singleCount = sumHistogramSeries(metrics, 'cat_cafe_a2a_successor_concurrent_successors_count', {
    action_successor_mode: 'single',
  });
  const singleSum = sumHistogramSeries(metrics, 'cat_cafe_a2a_successor_concurrent_successors_sum', {
    action_successor_mode: 'single',
  });
  const parallelCount = sumHistogramSeries(metrics, 'cat_cafe_a2a_successor_concurrent_successors_count', {
    action_successor_mode: 'parallel',
  });
  const responsesAfterTerminal = sumMetric(metrics, 'cat_cafe_a2a_successor_responses_after_terminal_state');
  const safeWait = sumMetric(metrics, 'cat_cafe_a2a_successor_safe_wait');
  const replace = sumMetric(metrics, 'cat_cafe_a2a_successor_replace');
  const multiMentionTotal = sumMetric(metrics, 'cat_cafe_a2a_successor_multi_mention');
  const singleTargetMultiMention = sumMetric(metrics, 'cat_cafe_a2a_successor_single_target_multi_mention');
  const unfencedSingleTargetMultiMention = sumMetric(
    metrics,
    'cat_cafe_a2a_successor_unfenced_single_target_multi_mention',
  );
  const actionFenceUnavailable = sumMetric(metrics, 'cat_cafe_a2a_successor_action_fence_unavailable');
  const agentKeyActionRejected = sumMetric(metrics, 'cat_cafe_a2a_successor_agent_key_action_rejected');
  const hasCounters = [
    uniqueCats,
    actionCount,
    singleCount,
    parallelCount,
    responsesAfterTerminal,
    safeWait,
    replace,
    multiMentionTotal,
    singleTargetMultiMention,
    unfencedSingleTargetMultiMention,
    actionFenceUnavailable,
    agentKeyActionRejected,
  ].some((value) => value != null);
  const effectiveSingleViolations = calculateEffectiveSingleViolations(
    singleCount,
    singleSum,
    actionCount,
    parallelCount,
    hasCounters,
  );
  const singleTargetMultiMentionRate = calculateCounterRate(multiMentionTotal, singleTargetMultiMention);
  const telemetryGaps = buildTelemetryGaps(
    hasCounters,
    [
      {
        metric: 'successor.concurrent_successors',
        value: effectiveSingleViolations,
        impact: 'Cannot prove the single-mode holder count stayed at one',
      },
      {
        metric: 'successor.responses_after_terminal_state',
        value: responsesAfterTerminal,
        impact: 'Cannot prove terminal successor responses remained suppressed',
      },
      {
        metric: 'successor.safe_wait',
        value: safeWait,
        impact: 'Cannot observe active-holder conflict admission',
      },
      {
        metric: 'successor.replace',
        value: replace,
        impact: 'Cannot observe verified successor replacement',
      },
      {
        metric: 'successor.multi_mention_total',
        value: multiMentionTotal,
        impact: 'Cannot observe the multi_mention migration denominator',
      },
      {
        metric: 'successor.single_target_multi_mention_total',
        value: singleTargetMultiMention,
        impact: 'Cannot observe the single-target multi_mention migration numerator',
      },
      {
        metric: 'successor.unfenced_single_target_multi_mention',
        value: unfencedSingleTargetMultiMention,
        impact: 'Cannot detect legacy single-target dispatches without a successor fence',
      },
      {
        metric: 'successor.action_fence_unavailable',
        value: actionFenceUnavailable,
        impact: 'Cannot detect durable successor admission or runtime wiring failures',
      },
      {
        metric: 'successor.agent_key_action_rejected',
        value: agentKeyActionRejected,
        impact: 'Cannot distinguish expected agent-key rejection from admission wiring failure',
      },
    ],
    singleTargetMultiMentionRate,
  );

  return {
    componentId: 'action-successor-single-flight',
    componentName: 'action successor single-flight guard',
    activationCounts: observedCounts(hasCounters, {
      'successor.unique_cats_invoked_total': uniqueCats ?? 0,
      'successor.actions_observed': actionCount ?? 0,
      'successor.explicit_parallel_observations': parallelCount ?? 0,
      'successor.safe_wait': safeWait,
      'successor.replace': replace,
      'successor.multi_mention_total': multiMentionTotal,
      'successor.single_target_multi_mention_total': singleTargetMultiMention,
      ...(singleTargetMultiMentionRate == null
        ? {}
        : { 'successor.single_target_multi_mention_rate': singleTargetMultiMentionRate }),
    }),
    frictionCounts: observedCounts(hasCounters, {
      'successor.concurrent_single_violations': effectiveSingleViolations,
      'successor.responses_after_terminal_state': responsesAfterTerminal,
      'successor.unfenced_single_target_multi_mention': unfencedSingleTargetMultiMention,
      'successor.action_fence_unavailable': actionFenceUnavailable,
      'successor.agent_key_action_rejected': agentKeyActionRejected,
    }),
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasCounters ? (telemetryGaps.length > 0 ? 'low' : 'medium') : 'no-data',
    telemetryGaps,
  };
}
