import type {
  EvalMetricsHistoryResponse,
  EvalTraceSpan,
  EvalTraceStoreStats,
  EvalTracesResponse,
} from './telemetry-adapter.js';

export interface TelemetryGap {
  metric: string;
  reason:
    | 'no_counter'
    | 'span_not_persisted'
    | 'tool_use_not_queryable'
    | 'cross_cat_403'
    | 'trace_context_incomplete'
    | 'ttl_expired';
  impact: string;
}

export interface ComponentHealth {
  componentId: string;
  componentName: string;
  activationCounts: Record<string, number | null>;
  frictionCounts: Record<string, number | null>;
  falsePositiveCandidates: string[];
  bypassCandidates: string[];
  confidence: 'high' | 'medium' | 'low' | 'no-data';
  telemetryGaps: TelemetryGap[];
}

export interface RuntimeEvalSnapshot {
  featureId: string;
  window: { startMs: number; endMs: number; durationHours: number };
  dataSource: string;
  generatedAt: string;
  generatedBy: string;
  traceStoreStats: EvalTraceStoreStats;
  components: ComponentHealth[];
  overallConfidence: 'high' | 'medium' | 'low' | 'no-data';
  summary: string;
}

export interface F167EvalInput {
  traces: EvalTracesResponse;
  metrics: Record<string, number>;
  metricsHistory: EvalMetricsHistoryResponse;
  traceStats: EvalTraceStoreStats;
}

// Prometheus key → short name mapping (dots in OTel become underscores in Prom)
const PROM_TO_SHORT: Record<string, string> = {
  cat_cafe_a2a_inline_action_checked: 'inline_action.checked',
  cat_cafe_a2a_inline_action_detected: 'inline_action.detected',
  cat_cafe_a2a_inline_action_shadow_miss: 'inline_action.shadow_miss',
  cat_cafe_a2a_inline_action_feedback_written: 'inline_action.feedback_written',
  cat_cafe_a2a_inline_action_feedback_write_failed: 'inline_action.feedback_write_failed',
  cat_cafe_a2a_inline_action_hint_emitted: 'inline_action.hint_emitted',
  cat_cafe_a2a_inline_action_hint_emit_failed: 'inline_action.hint_emit_failed',
  cat_cafe_a2a_inline_action_routed_set_skip: 'inline_action.routed_set_skip',
  cat_cafe_a2a_line_start_detected: 'line_start.detected',
};

const ROUTE_SERIAL_ACTIVATION = new Set(['inline_action.checked', 'inline_action.detected', 'line_start.detected']);

const ROUTE_SERIAL_FRICTION = new Set([
  'inline_action.shadow_miss',
  'inline_action.feedback_written',
  'inline_action.feedback_write_failed',
  'inline_action.hint_emitted',
  'inline_action.hint_emit_failed',
  'inline_action.routed_set_skip',
]);

function normalizePromKey(raw: string): string {
  const noLabels = raw.replace(/\{[^}]*\}/, '');
  return noLabels.replace(/_total$/, '');
}

function extractRouteSerialCounters(metrics: Record<string, number>): {
  activation: Record<string, number>;
  friction: Record<string, number>;
} {
  const activation: Record<string, number> = {};
  const friction: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    const normalized = normalizePromKey(key);
    const short = PROM_TO_SHORT[normalized];
    if (!short) continue;
    if (ROUTE_SERIAL_ACTIVATION.has(short)) {
      activation[short] = (activation[short] ?? 0) + value;
    }
    if (ROUTE_SERIAL_FRICTION.has(short)) {
      friction[short] = (friction[short] ?? 0) + value;
    }
  }
  return { activation, friction };
}

function countHoldBallFromTraces(spans: EvalTraceSpan[]): number {
  let count = 0;
  for (const span of spans) {
    const toolName = span.attributes['tool.name'] as string | undefined;
    if (toolName === 'cat_cafe_hold_ball' || (toolName && toolName.endsWith('__cat_cafe_hold_ball'))) {
      count++;
    }
  }
  return count;
}

function buildL1(metrics: Record<string, number>): ComponentHealth {
  const streakWarn = sumMetricByPrefix(metrics, 'cat_cafe_a2a_l1_streak_warn_count');
  const streakBreak = sumMetricByPrefix(metrics, 'cat_cafe_a2a_l1_streak_break_count');
  const hasCounters = streakWarn != null || streakBreak != null;

  const activationCounts: Record<string, number | null> = {};
  if (hasCounters) {
    activationCounts['l1.streak_warn_count'] = streakWarn ?? 0;
    activationCounts['l1.streak_break_count'] = streakBreak ?? 0;
  }

  return {
    componentId: 'L1',
    componentName: 'WorklistRegistry (ping-pong breaker)',
    activationCounts,
    frictionCounts: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasCounters ? 'medium' : 'no-data',
    telemetryGaps: hasCounters
      ? []
      : [
          {
            metric: 'streak_warn_count',
            reason: 'no_counter',
            impact: 'Cannot measure L1 activation frequency',
          },
          {
            metric: 'streak_break_count',
            reason: 'no_counter',
            impact: 'Cannot measure L1 circuit-break events',
          },
        ],
  };
}

function buildC1(spans: EvalTraceSpan[], metrics: Record<string, number>): ComponentHealth {
  const holdBallCalls = countHoldBallFromTraces(spans);
  const zombieHold = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c1_zombie_hold_count');
  const holdCancel = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c1_hold_cancel_count');
  const hasCounters = zombieHold != null || holdCancel != null;
  const hasData = holdBallCalls > 0 || hasCounters;

  const frictionCounts: Record<string, number | null> = {};
  if (hasCounters) {
    frictionCounts['c1.zombie_hold_count'] = zombieHold ?? 0;
    frictionCounts['c1.hold_cancel_count'] = holdCancel ?? 0;
  }

  return {
    componentId: 'C1',
    componentName: 'hold_ball (MCP tool)',
    activationCounts: { hold_ball_calls: holdBallCalls },
    frictionCounts,
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasData ? (hasCounters ? 'medium' : 'low') : 'no-data',
    telemetryGaps: hasCounters
      ? []
      : [
          {
            metric: 'zombie_hold_count',
            reason: 'no_counter',
            impact: 'Cannot detect zombie holds (hold without follow-up action)',
          },
          {
            metric: 'hold_cancel_count',
            reason: 'no_counter',
            impact: 'Cannot measure hold cancellation frequency',
          },
        ],
  };
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

function buildC2(metrics: Record<string, number>): ComponentHealth {
  const hintCount = sumMetricByPrefix(metrics, 'cat_cafe_a2a_inline_action_hint_emitted');
  const verdictHint = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_verdict_hint_emitted');
  const voidHoldHint = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_void_hold_hint_emitted');
  const verdictWithoutPass = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_verdict_without_pass_count');
  const hasSplitCounters = verdictHint != null || voidHoldHint != null || verdictWithoutPass != null;
  const hasData = hasSplitCounters || (hintCount != null && hintCount > 0);

  const activationCounts: Record<string, number | null> = {
    'hint_emitted (mixed routing+verdict)': hintCount,
  };
  if (hasSplitCounters) {
    activationCounts['c2.verdict_hint_emitted'] = verdictHint ?? 0;
    activationCounts['c2.void_hold_hint_emitted'] = voidHoldHint ?? 0;
    activationCounts['c2.verdict_without_pass_count'] = verdictWithoutPass ?? 0;
  }

  const gaps: TelemetryGap[] = [];
  if (!hasSplitCounters) {
    gaps.push({
      metric: 'hint_emitted',
      reason: 'trace_context_incomplete',
      impact: 'Counter mixes routing hints and verdict hints — cannot isolate C2 exit-check activations',
    });
    gaps.push({
      metric: 'verdict_without_pass_count',
      reason: 'no_counter',
      impact: 'Cannot directly count forced-pass triggers',
    });
  }

  return {
    componentId: 'C2',
    componentName: 'exit-check (forced-pass guard)',
    activationCounts,
    frictionCounts: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasData ? (hasSplitCounters ? 'medium' : 'low') : 'no-data',
    telemetryGaps: gaps,
  };
}

function buildRouteSerial(metrics: Record<string, number>, hasTraceData: boolean): ComponentHealth {
  const { activation, friction } = extractRouteSerialCounters(metrics);
  const hasCounters = Object.keys(activation).length > 0;
  let confidence: ComponentHealth['confidence'] = 'no-data';
  if (hasCounters && hasTraceData) confidence = 'high';
  else if (hasCounters) confidence = 'medium';
  return {
    componentId: 'route-serial',
    componentName: 'route-serial (A2A handoff routing)',
    activationCounts: activation,
    frictionCounts: friction,
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence,
    telemetryGaps: [],
  };
}

const CONFIDENCE_ORDER: ComponentHealth['confidence'][] = ['no-data', 'low', 'medium', 'high'];

function worstConfidence(components: ComponentHealth[]): ComponentHealth['confidence'] {
  let worst = 3;
  for (const c of components) {
    const idx = CONFIDENCE_ORDER.indexOf(c.confidence);
    if (idx < worst) worst = idx;
  }
  return CONFIDENCE_ORDER[worst];
}

export function generateF167Snapshot(input: F167EvalInput): RuntimeEvalSnapshot {
  const now = Date.now();
  const hasTraceData = input.traceStats.oldestStoredAt != null && input.traceStats.newestStoredAt != null;
  const windowStart = input.traceStats.oldestStoredAt ?? now;
  const windowEnd = input.traceStats.newestStoredAt ?? now;
  const durationMs = windowEnd - windowStart;

  const components = [
    buildL1(input.metrics),
    buildC1(input.traces.spans, input.metrics),
    buildC2(input.metrics),
    buildRouteSerial(input.metrics, hasTraceData),
  ];

  const overall = worstConfidence(components);
  const gapCount = components.reduce((sum, c) => sum + c.telemetryGaps.length, 0);
  const dataComponents = components.filter((c) => c.confidence !== 'no-data').length;

  return {
    featureId: 'F167',
    window: {
      startMs: windowStart,
      endMs: windowEnd,
      durationHours: durationMs / 3_600_000,
    },
    dataSource: 'F153 /api/telemetry/*',
    generatedAt: new Date(now).toISOString(),
    generatedBy: 'F192 Phase C eval',
    traceStoreStats: input.traceStats,
    components,
    overallConfidence: overall,
    summary:
      `F167 A2A harness eval: ${dataComponents}/4 components have telemetry data. ` +
      `${gapCount} telemetry gaps identified. ` +
      `Overall confidence: ${overall}.`,
  };
}
