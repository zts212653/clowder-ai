/**
 * F153 Phase I: Step Summary aggregation — per-route scope.
 *
 * Computes step metrics scoped to a single `cat_cafe.route` span subtree.
 * When `routeSpanId` is provided, only descendants of that route are counted.
 * When omitted, the root route span is auto-detected. Descriptive only (no
 * efficiency or quality scoring, per KD-16/KD-32).
 *
 * Null sub-counts (`agent_loop_count` / `tool_call_count` / `a2a_dispatch_count`)
 * are returned when the trace is restored (flattened to
 * `cat_cafe.invocation.restored`, hierarchy lost) OR when no provider emitted
 * the `cat_cafe.agent_loop` marker. UI must render `—` for null, not `0`
 * (AC-I4 / AC-I7 non-degradation).
 */

import type { TraceSpanDTO } from './local-trace-store.js';

/** OTel SpanStatusCode.ERROR */
const SPAN_STATUS_ERROR = 2;

/** Step summary scoped to one route span subtree. */
export interface StepSummary {
  traceId: string;
  /** The route span this summary is scoped to (undefined only for legacy/restored traces). */
  routeSpanId?: string;
  /** Length: total agent loops in this route. null when restored or no provider marker. */
  agent_loop_count: number | null;
  /** Total tool calls (MCP child spans + basic-tool counter). null when restored. */
  tool_call_count: number | null;
  /** A2A dispatch count = number of cat_cafe.mention_dispatch spans. null when restored. */
  a2a_dispatch_count: number | null;
  /** Route duration in ms. Always available (route span or trace time-range fallback). */
  duration_ms: number;
  /** Total tokens from cat_cafe.route span attribute route.total_tokens. */
  token_total: number;
  /** Number of spans with ERROR status code. */
  error_count: number;
  /** Whether all invocation spans are restored (hierarchy lost). */
  is_restored: boolean;
  /** Width: avg tools per agent loop. null when either length or tool count is null. */
  width_avg_tools_per_loop: number | null;
  /** True when some live invocations have agent_loop.count and others do not (mixed-provider). */
  agent_loop_partial: boolean;
}

/**
 * Collect all descendant spans of `rootSpanId` (BFS on parentSpanId), including root itself.
 */
function collectSubtree(spans: TraceSpanDTO[], rootSpanId: string): TraceSpanDTO[] {
  const byParent = new Map<string, TraceSpanDTO[]>();
  for (const s of spans) {
    if (s.parentSpanId) {
      const siblings = byParent.get(s.parentSpanId);
      if (siblings) {
        siblings.push(s);
      } else {
        byParent.set(s.parentSpanId, [s]);
      }
    }
  }
  const root = spans.find((s) => s.spanId === rootSpanId);
  if (!root) return [];
  const result: TraceSpanDTO[] = [root];
  const queue = [rootSpanId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const children = byParent.get(id);
    if (!children) continue;
    for (const child of children) {
      result.push(child);
      queue.push(child.spanId);
    }
  }
  return result;
}

/**
 * Aggregate spans into a StepSummary scoped to a single route. Returns null when no spans.
 *
 * @param routeSpanId — scope to this route span's subtree. When omitted, auto-detects
 *   the root `cat_cafe.route` span (the one without a parent that is also a route).
 *
 * NOTE: descriptive only — never compute efficiency / quality / normative scores
 * here. The UI must not synthesize such fields either (per AC-I5, KD-32).
 */
export function computeStepSummary(spans: TraceSpanDTO[], traceId: string, routeSpanId?: string): StepSummary | null {
  if (spans.length === 0) return null;

  // Determine the target route span and scope spans to its subtree.
  let targetRouteSpanId = routeSpanId;
  if (!targetRouteSpanId) {
    const routeSpans = spans.filter((s) => s.name === 'cat_cafe.route');
    const allSpanIds = new Set(spans.map((s) => s.spanId));
    // Root route = parent absent from this trace (not just absent from route spans).
    // In A2A chains, child routes parent to mention_dispatch, not to the parent route.
    // Earliest startTimeMs breaks ties when multiple routes lack an in-trace parent.
    const candidates = routeSpans
      .filter((s) => !s.parentSpanId || !allSpanIds.has(s.parentSpanId))
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
    targetRouteSpanId = candidates[0]?.spanId;
  }

  const scopedSpans = targetRouteSpanId ? collectSubtree(spans, targetRouteSpanId) : spans;
  if (scopedSpans.length === 0) return null;

  const routeSpan = scopedSpans.find((s) => s.spanId === targetRouteSpanId);
  const liveInvocationSpans = scopedSpans.filter((s) => s.name === 'cat_cafe.invocation');
  const restoredInvocationSpans = scopedSpans.filter((s) => s.name === 'cat_cafe.invocation.restored');

  const isRestored = liveInvocationSpans.length === 0 && restoredInvocationSpans.length > 0;

  // agent_loop_count: sum `agent_loop.count` across live invocation spans in this route subtree.
  let agentLoopCount: number | null = null;
  let agentLoopPartial = false;
  if (!isRestored) {
    const withAttr = liveInvocationSpans.filter((s) => typeof s.attributes['agent_loop.count'] === 'number');
    const withoutAttr = liveInvocationSpans.filter((s) => typeof s.attributes['agent_loop.count'] !== 'number');
    if (withAttr.length > 0) {
      agentLoopCount = withAttr.map((s) => s.attributes['agent_loop.count'] as number).reduce((a, b) => a + b, 0);
      agentLoopPartial = withoutAttr.length > 0;
    }
  }

  // tool_call_count: MCP child spans + basic-tool counter (dual-track per KD-35).
  let toolCallCount: number | null = null;
  if (!isRestored) {
    const mcpToolUseSpans = scopedSpans.filter((s) => s.name.startsWith('cat_cafe.tool_use ')).length;
    const basicCounts = liveInvocationSpans
      .map((s) => s.attributes['tool.basic_call_count'])
      .filter((v): v is number => typeof v === 'number')
      .reduce((a, b) => a + b, 0);
    toolCallCount = mcpToolUseSpans + basicCounts;
  }

  // a2a_dispatch_count: mention_dispatch spans within this route subtree only.
  let a2aDispatchCount: number | null = null;
  if (!isRestored) {
    a2aDispatchCount = scopedSpans.filter((s) => s.name === 'cat_cafe.mention_dispatch').length;
  }

  const durationMs = routeSpan?.durationMs ?? computeTraceDuration(scopedSpans);

  const tokenTotal =
    routeSpan && typeof routeSpan.attributes['route.total_tokens'] === 'number'
      ? (routeSpan.attributes['route.total_tokens'] as number)
      : 0;

  const errorCount = scopedSpans.filter((s) => s.status.code === SPAN_STATUS_ERROR).length;

  const width: number | null =
    !agentLoopPartial && agentLoopCount != null && agentLoopCount > 0 && toolCallCount != null
      ? toolCallCount / agentLoopCount
      : null;

  return {
    traceId,
    routeSpanId: targetRouteSpanId,
    agent_loop_count: agentLoopCount,
    tool_call_count: toolCallCount,
    a2a_dispatch_count: a2aDispatchCount,
    duration_ms: durationMs,
    token_total: tokenTotal,
    error_count: errorCount,
    is_restored: isRestored,
    width_avg_tools_per_loop: width,
    agent_loop_partial: agentLoopPartial,
  };
}

function computeTraceDuration(spans: TraceSpanDTO[]): number {
  if (spans.length === 0) return 0;
  let start = Infinity;
  let end = -Infinity;
  for (const s of spans) {
    if (s.startTimeMs < start) start = s.startTimeMs;
    if (s.endTimeMs > end) end = s.endTimeMs;
  }
  return end - start;
}
