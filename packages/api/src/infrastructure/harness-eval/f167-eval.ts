import type { ClaimGroundingEvent } from '../grounding/types.js';
import { extractC1HoldZombieSamples } from './c1-hold-sample-evidence.js';
import { extractC2VerdictWithoutPassSamples, type PerFireSample } from './c2-sample-evidence.js';
import { extractC2VoidHoldSamples } from './c2-void-hold-sample-evidence.js';
// R3 cloud P1 follow-up: counterWindow construction extracted to keep this
// pre-existing-over-limit file (475 lines on main) from getting worse.
import { buildCounterWindow, type CounterWindow, type CounterWindowInput } from './f167-eval-counter-window.js';
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
  /** F192 Phase D — per-fire sample evidence keyed by friction metric name; see `attribution.SAMPLED_METRICS`. */
  frictionSamples: Record<string, PerFireSample[]>;
  falsePositiveCandidates: string[];
  bypassCandidates: string[];
  confidence: 'high' | 'medium' | 'low' | 'no-data';
  telemetryGaps: TelemetryGap[];
}

/** F167 Phase O PR-O2b: grounding sample evidence for F192 verdict consumption. */
export interface GroundingSampleEvidence {
  /** Total sampled events in this snapshot. */
  totalSampled: number;
  /** Breakdown by verdict. */
  byVerdict: Record<string, number>;
  /** Breakdown by tool. */
  byTool: Record<string, number>;
  /** Up to 20 most recent mismatch/insufficient events for human review. */
  recentActionable: Array<{
    ts: number;
    tool: string;
    claimType: string;
    verdict: string;
    verdictReason: string;
    resolver: string;
    sourceTier: string;
    catId: string;
    threadId: string;
    sourceRef: string;
  }>;
}

export interface RuntimeEvalSnapshot {
  featureId: string;
  window: { startMs: number; endMs: number; durationHours: number };
  /** See ./f167-eval-counter-window.ts for shape + rationale (silent FP fix). */
  counterWindow?: CounterWindow;
  dataSource: string;
  generatedAt: string;
  generatedBy: string;
  traceStoreStats: EvalTraceStoreStats;
  components: ComponentHealth[];
  overallConfidence: 'high' | 'medium' | 'low' | 'no-data';
  summary: string;
  /** F167 Phase O PR-O2b: grounding sample evidence (undefined if no samples). */
  groundingSampleEvidence?: GroundingSampleEvidence;
}

export interface F167EvalInput extends CounterWindowInput {
  traces: EvalTracesResponse;
  metrics: Record<string, number>;
  metricsHistory: EvalMetricsHistoryResponse;
  traceStats: EvalTraceStoreStats;
  /** F167 Phase O PR-O2b: grounding sample events from bounded store. */
  groundingSamples?: ClaimGroundingEvent[];
  // F167 sibling-PR: processStartMs + processUptimeSec inherited from
  // CounterWindowInput. See ./f167-eval-counter-window.ts for the contract.
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
    frictionSamples: {},
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
  // F192 verdict 2026-06-18 (砚砚 R1 P1 #1): replacement is throughput
  // (activation), zombie is friction. Putting replacement in frictionCounts
  // would re-create the 06-18 false-positive shape under the renamed metric.
  const holdZombie = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c1_hold_zombie_count');
  const holdReplacement = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c1_hold_replacement_count');
  const holdCancel = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c1_hold_cancel_count');
  const hasCounters = holdZombie != null || holdReplacement != null || holdCancel != null;
  const hasData = holdBallCalls > 0 || hasCounters;

  const activationCounts: Record<string, number | null> = { hold_ball_calls: holdBallCalls };
  if (holdReplacement != null) activationCounts['c1.hold_replacement_count'] = holdReplacement;
  const frictionCounts: Record<string, number | null> = {};
  if (hasCounters) {
    frictionCounts['c1.hold_zombie_count'] = holdZombie ?? 0;
    frictionCounts['c1.hold_cancel_count'] = holdCancel ?? 0;
  }
  // Only zombie samples surface under frictionSamples (sampled metric +
  // drilldown). Replacement samples available via spans for ad-hoc debug.
  const zombieSamples = extractC1HoldZombieSamples(spans);
  const frictionSamples: Record<string, PerFireSample[]> =
    zombieSamples.length > 0 ? { 'c1.hold_zombie_count': zombieSamples } : {};

  return {
    componentId: 'C1',
    componentName: 'hold_ball (MCP tool)',
    activationCounts,
    frictionCounts,
    frictionSamples,
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasData ? (hasCounters ? 'medium' : 'low') : 'no-data',
    telemetryGaps: hasCounters
      ? []
      : [
          {
            metric: 'hold_zombie_count',
            reason: 'no_counter',
            impact: 'Cannot detect true zombie holds (overdue/imminent wake suppressed)',
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

function buildC2(spans: EvalTraceSpan[], metrics: Record<string, number>): ComponentHealth {
  const hintCount = sumMetricByPrefix(metrics, 'cat_cafe_a2a_inline_action_hint_emitted');
  const verdictHint = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_verdict_hint_emitted');
  const voidHoldHint = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_void_hold_hint_emitted');
  const verdictWithoutPass = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_verdict_without_pass_count');
  const exitChecked = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_exit_checked');
  const voidHoldChecked = sumMetricByPrefix(metrics, 'cat_cafe_a2a_c2_void_hold_checked');
  const hasSplitCounters = verdictHint != null || voidHoldHint != null || verdictWithoutPass != null;
  const hasData = hasSplitCounters || (hintCount != null && hintCount > 0);

  // F192 Phase D — per-fire sample evidence for verdict_without_pass fires.
  // Extracted regardless of `hasSplitCounters`: if events exist but counters are
  // (somehow) missing, samples are still surfaced so attribution can still drill down.
  const verdictWithoutPassSamples = extractC2VerdictWithoutPassSamples(spans);
  // F192 Phase D — eval:a2a 2026-06-10 build verdict: parallel per-fire samples
  // for void_hold_hint fires. Same extraction discipline, different event name.
  // The C2 finding can now classify void-hold fires (e.g. distinguish a noisy
  // `cn_chiqiu` regex from a rare `mcp_tool_name` narrative reference).
  const voidHoldSamples = extractC2VoidHoldSamples(spans);
  const frictionSamples: Record<string, PerFireSample[]> = {};
  if (verdictWithoutPassSamples.length > 0) {
    frictionSamples['c2.verdict_without_pass_count'] = verdictWithoutPassSamples;
  }
  if (voidHoldSamples.length > 0) {
    frictionSamples['c2.void_hold_hint_emitted'] = voidHoldSamples;
  }

  const activationCounts: Record<string, number | null> = {
    'hint_emitted (mixed routing+verdict)': hintCount,
  };
  const frictionCounts: Record<string, number | null> = {};
  if (hasSplitCounters) {
    activationCounts['c2.verdict_hint_emitted'] = verdictHint ?? 0;
    // Two distinct C2 denominators (PR #1941 P2): verdict_without_pass is graded against
    // c2.checked (verdict exit-check count), void_hold against c2.void_hold_checked (the
    // separate void-hold guard). Absent (old runtime) → 0 → attribution surfaces the
    // friction at low severity instead of fabricating a ratio against the wrong base.
    activationCounts['c2.checked'] = exitChecked ?? 0;
    activationCounts['c2.void_hold_checked'] = voidHoldChecked ?? 0;
    frictionCounts['c2.verdict_without_pass_count'] = verdictWithoutPass ?? 0;
    frictionCounts['c2.void_hold_hint_emitted'] = voidHoldHint ?? 0;
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
    frictionCounts,
    frictionSamples,
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
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence,
    telemetryGaps: [],
  };
}

/**
 * F167 Phase O PR-O2b: grounding shadow telemetry component.
 * Consumes counters + bounded sample evidence from grounding-checker.ts.
 */
function buildGroundingPhaseO(
  metrics: Record<string, number>,
  groundingSamples: ClaimGroundingEvent[] = [],
): ComponentHealth {
  // normalizePromKey strips _total suffix, so prefix must match the normalized form
  const checkTotal = sumMetricByPrefix(metrics, 'cat_cafe_a2a_grounding_check');
  const verdictTotal = sumMetricByPrefix(metrics, 'cat_cafe_a2a_grounding_verdict');
  const resolverTotal = sumMetricByPrefix(metrics, 'cat_cafe_a2a_grounding_resolver');
  const cacheHitTotal = sumMetricByPrefix(metrics, 'cat_cafe_a2a_grounding_cache_hit');
  const budgetExhausted = sumMetricByPrefix(metrics, 'cat_cafe_a2a_grounding_budget_exhausted');

  const hasCounters = checkTotal != null || verdictTotal != null;

  const activationCounts: Record<string, number | null> = {};
  const frictionCounts: Record<string, number | null> = {};
  if (hasCounters) {
    activationCounts['grounding.check_total'] = checkTotal ?? 0;
    activationCounts['grounding.verdict_total'] = verdictTotal ?? 0;
    activationCounts['grounding.resolver_total'] = resolverTotal ?? 0;
    activationCounts['grounding.cache_hit_total'] = cacheHitTotal ?? 0;
    frictionCounts['grounding.budget_exhausted_total'] = budgetExhausted ?? 0;
  }

  // PR-O2b: surface sample count in activation counters
  if (groundingSamples.length > 0) {
    activationCounts['grounding.sample_count'] = groundingSamples.length;
    activationCounts['grounding.mismatch_sample_count'] = groundingSamples.filter(
      (e) => e.verdict === 'mismatch',
    ).length;
  }

  const gaps: TelemetryGap[] = [];
  if (!hasCounters) {
    gaps.push({
      metric: 'grounding.check_total',
      reason: 'no_counter',
      impact: 'Phase O shadow grounding not emitting — hook may not be wired or no stateful tool calls observed',
    });
  }

  return {
    componentId: 'grounding-phase-o',
    componentName: 'claim grounding (Phase O shadow)',
    activationCounts,
    frictionCounts,
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasCounters ? 'medium' : 'no-data',
    telemetryGaps: gaps,
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

/** PR-O2b: Build grounding sample evidence for the snapshot. */
function buildGroundingSampleEvidence(samples: ClaimGroundingEvent[]): GroundingSampleEvidence | undefined {
  if (samples.length === 0) return undefined;

  const byVerdict: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const s of samples) {
    byVerdict[s.verdict] = (byVerdict[s.verdict] ?? 0) + 1;
    byTool[s.tool] = (byTool[s.tool] ?? 0) + 1;
  }

  // Surface actionable events (mismatch + insufficient) for human review, capped at 20.
  const actionable = samples
    .filter((e) => e.verdict === 'mismatch' || e.verdict === 'insufficient')
    .slice(-20)
    .map((e) => ({
      ts: e.ts,
      tool: e.tool,
      claimType: e.claimType,
      verdict: e.verdict,
      verdictReason: e.verdictReason ?? '',
      resolver: e.resolver,
      sourceTier: e.resolverSourceTier,
      catId: e.catId,
      threadId: e.threadId,
      sourceRef: `${e.sourceRef.kind}:${e.sourceRef.value}`,
    }));

  return {
    totalSampled: samples.length,
    byVerdict,
    byTool,
    recentActionable: actionable,
  };
}

export function generateF167Snapshot(input: F167EvalInput): RuntimeEvalSnapshot {
  const now = Date.now();
  const hasTraceData = input.traceStats.oldestStoredAt != null && input.traceStats.newestStoredAt != null;
  const windowStart = input.traceStats.oldestStoredAt ?? now;
  const windowEnd = input.traceStats.newestStoredAt ?? now;
  const durationMs = windowEnd - windowStart;

  const groundingSamples = input.groundingSamples ?? [];

  const components = [
    buildL1(input.metrics),
    buildC1(input.traces.spans, input.metrics),
    buildC2(input.traces.spans, input.metrics),
    buildRouteSerial(input.metrics, hasTraceData),
    buildGroundingPhaseO(input.metrics, groundingSamples),
  ];

  const overall = worstConfidence(components);
  const gapCount = components.reduce((sum, c) => sum + c.telemetryGaps.length, 0);
  const dataComponents = components.filter((c) => c.confidence !== 'no-data').length;

  // F167 sibling-PR: counter-domain window = process boot → now.
  // Construction lives in ./f167-eval-counter-window.ts to keep this
  // pre-existing-over-limit file from getting worse (R3 cloud P1 follow-up).
  const counterWindow = buildCounterWindow(input, now);

  return {
    featureId: 'F167',
    window: {
      startMs: windowStart,
      endMs: windowEnd,
      durationHours: durationMs / 3_600_000,
    },
    ...(counterWindow ? { counterWindow } : {}),
    dataSource: 'F153 /api/telemetry/*',
    generatedAt: new Date(now).toISOString(),
    generatedBy: 'F192 Phase C eval',
    traceStoreStats: input.traceStats,
    components,
    overallConfidence: overall,
    summary:
      `F167 A2A harness eval: ${dataComponents}/${components.length} components have telemetry data. ` +
      `${gapCount} telemetry gaps identified. ` +
      `Overall confidence: ${overall}.`,
    groundingSampleEvidence: buildGroundingSampleEvidence(groundingSamples),
  };
}
