import { HOLD_EXPIRED_AFTER_SATISFIED_EVENT_NAME } from '../scheduler/hold-lifecycle-telemetry.js';
import { extractPerFireSamples, type PerFireSample } from './c2-sample-evidence.js';
import type { ComponentHealth, TelemetryGap } from './f167-eval.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export const PHASE_Q_EXPIRED_AFTER_SATISFIED_EVENT_NAME = HOLD_EXPIRED_AFTER_SATISFIED_EVENT_NAME;
export const PHASE_Q_EXPIRED_AFTER_SATISFIED_METRIC = 'hold_lifecycle.expired_after_satisfied_total';

const PHASE_Q_SAMPLE_EXTRA_ATTRS = ['taskIdHash', 'subjectKeyHash', 'expectedSignalKey', 'sourceKind'] as const;

function normalizePromKey(raw: string): string {
  const noLabels = raw.replace(/\{[^}]*\}/, '');
  return noLabels.replace(/_total$/, '');
}

function sumMetricByPrefix(metrics: Record<string, number>, prefix: string): number | null {
  let sum = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (normalizePromKey(key) === prefix) {
      sum += value;
      found = true;
    }
  }
  return found ? sum : null;
}

function hasMetric(values: ReadonlyArray<number | null>): boolean {
  return values.some((value) => value !== null);
}

export function extractPhaseQExpiredAfterSatisfiedSamples(spans: ReadonlyArray<EvalTraceSpan>): PerFireSample[] {
  return extractPerFireSamples(
    spans,
    PHASE_Q_EXPIRED_AFTER_SATISFIED_EVENT_NAME,
    { total: 10, perTrigger: 5 },
    PHASE_Q_SAMPLE_EXTRA_ATTRS,
  );
}

export function buildHoldLifecyclePhaseQ(
  spans: ReadonlyArray<EvalTraceSpan>,
  metrics: Record<string, number>,
): ComponentHealth {
  const eventRetired = sumMetricByPrefix(metrics, 'cat_cafe_a2a_hold_event_retired');
  const staleWakeSuppressed = sumMetricByPrefix(metrics, 'cat_cafe_a2a_hold_stale_wake_suppressed');
  const expiredAfterSatisfied = sumMetricByPrefix(metrics, 'cat_cafe_a2a_hold_expired_after_satisfied');
  const hasEventRetiredCounter = eventRetired !== null;
  const hasStaleWakeSuppressedCounter = staleWakeSuppressed !== null;
  const hasActivationCounters = hasEventRetiredCounter && hasStaleWakeSuppressedCounter;
  const hasRequiredFrictionCounter = expiredAfterSatisfied !== null;
  const hasAnyCounter = hasMetric([eventRetired, staleWakeSuppressed, expiredAfterSatisfied]);

  const activationCounts: Record<string, number | null> = {};
  const frictionCounts: Record<string, number | null> = {};
  if (hasAnyCounter) {
    activationCounts['hold_lifecycle.event_retired_total'] = eventRetired;
    activationCounts['hold_lifecycle.stale_wake_suppressed_total'] = staleWakeSuppressed;
  }
  if (hasRequiredFrictionCounter) {
    frictionCounts[PHASE_Q_EXPIRED_AFTER_SATISFIED_METRIC] = expiredAfterSatisfied;
  }

  const expiredAfterSatisfiedSamples = extractPhaseQExpiredAfterSatisfiedSamples(spans);
  const frictionSamples: Record<string, PerFireSample[]> =
    expiredAfterSatisfiedSamples.length > 0
      ? { [PHASE_Q_EXPIRED_AFTER_SATISFIED_METRIC]: expiredAfterSatisfiedSamples }
      : {};

  const telemetryGaps: TelemetryGap[] = [];
  if (!hasEventRetiredCounter) {
    telemetryGaps.push({
      metric: 'hold_lifecycle.event_retired_total',
      reason: 'no_counter',
      impact: 'Cannot verify Phase Q event-backed retirement activation counter',
    });
  }
  if (!hasStaleWakeSuppressedCounter) {
    telemetryGaps.push({
      metric: 'hold_lifecycle.stale_wake_suppressed_total',
      reason: 'no_counter',
      impact: 'Cannot verify Phase Q stale-wake suppression activation counter',
    });
  }
  if (!hasRequiredFrictionCounter) {
    telemetryGaps.push({
      metric: PHASE_Q_EXPIRED_AFTER_SATISFIED_METRIC,
      reason: 'no_counter',
      impact: 'Cannot enforce the zero-tolerance invariant for hold expiry after satisfied wait',
    });
  }

  return {
    componentId: 'hold-lifecycle-phase-q',
    componentName: 'hold lifecycle (Phase Q event-backed retirement)',
    activationCounts,
    frictionCounts,
    frictionSamples,
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasAnyCounter && telemetryGaps.length === 0 ? 'medium' : 'no-data',
    telemetryGaps,
  };
}
