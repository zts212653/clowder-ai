import type { ComponentHealth } from './f167-eval.js';

function normalizedMetricName(raw: string): string {
  return raw.replace(/\{[^}]*\}/, '').replace(/_total$/, '');
}

function sumMetric(metrics: Record<string, number>, name: string): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (normalizedMetricName(key) !== name) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

/** F167 Phase R: ADR-031 eval projection for cross-thread terminal closure. */
export function buildCrossThreadCoordination(metrics: Record<string, number>): ComponentHealth {
  const active = sumMetric(metrics, 'cat_cafe_a2a_coordination_active_dispatch_count');
  const terminal = sumMetric(metrics, 'cat_cafe_a2a_coordination_terminal_dispatch_count');
  const suppressedAck = sumMetric(metrics, 'cat_cafe_a2a_coordination_terminal_ack_suppressed_count');
  const hasCounters = active != null || terminal != null || suppressedAck != null;

  return {
    componentId: 'cross-thread-coordination',
    componentName: 'cross-thread coordination terminal guard',
    activationCounts: hasCounters
      ? {
          'coordination.active_dispatch_count': active ?? 0,
          'coordination.terminal_dispatch_count': terminal ?? 0,
          'coordination.terminal_ack_suppressed_count': suppressedAck ?? 0,
        }
      : {},
    frictionCounts: {},
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasCounters ? 'medium' : 'no-data',
    telemetryGaps: hasCounters
      ? []
      : [
          {
            metric: 'coordination.active_dispatch_count',
            reason: 'no_counter',
            impact: 'Cannot observe stable cross-thread coordination adoption or terminal ACK suppression',
          },
        ],
  };
}
