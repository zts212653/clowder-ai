/**
 * F153 Phase B: Extracted span creation helpers for llm_call and tool_use.
 *
 * Previously inlined in invoke-single-cat.ts. Extracted here so the
 * instrumentation logic is testable independently of the full invocation flow.
 */

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { isMcpToolName } from '../../domains/cats/services/tool-usage/classify.js';
import {
  AGENT_ID,
  GENAI_MODEL,
  GENAI_SYSTEM,
  ROUTING_INTENT,
  ROUTING_STRATEGY,
  ROUTING_TARGET_CATS,
  TOOL_CATEGORY,
  TOOL_INPUT_KEYS,
  TOOL_NAME,
} from './genai-semconv.js';

const tracer = trace.getTracer('cat-cafe-api', '0.1.0');

export interface LlmCallUsage {
  durationApiMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Record a retrospective llm_call span as child of invocationSpan.
 * startTime is approximate: (now - durationApiMs).
 */
export function recordLlmCallSpan(
  invocationSpan: Span,
  catId: string,
  providerSystem: string,
  modelBucket: string,
  usage: LlmCallUsage,
  invocationId?: string,
): void {
  const parentCtx = trace.setSpan(context.active(), invocationSpan);
  const spanStartTime = new Date(Date.now() - usage.durationApiMs);
  const llmSpan = tracer.startSpan(
    'cat_cafe.llm_call',
    {
      attributes: {
        [AGENT_ID]: catId,
        [GENAI_SYSTEM]: providerSystem,
        [GENAI_MODEL]: modelBucket,
        ...(usage.inputTokens ? { 'gen_ai.usage.input_tokens': usage.inputTokens } : {}),
        ...(usage.outputTokens ? { 'gen_ai.usage.output_tokens': usage.outputTokens } : {}),
        ...(usage.cacheReadTokens ? { 'gen_ai.usage.cache_read_tokens': usage.cacheReadTokens } : {}),
        ...(invocationId ? { invocationId } : {}),
      },
      startTime: spanStartTime,
    },
    parentCtx,
  );
  llmSpan.setStatus({ code: SpanStatusCode.OK });
  llmSpan.end();
}

const MEMORY_TOOL_PREFIXES = [
  'cat_cafe_search_evidence',
  // F193 Phase D AC-D1: cat_cafe_reflect removed from canonical taxonomy
  'cat_cafe_read_session',
  'cat_cafe_read_invocation',
  'cat_cafe_review_distillation',
];

function classifyToolCategory(toolName: string): string | undefined {
  if (MEMORY_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'memory';
  return undefined;
}

/**
 * Record a tool_use. MCP/business tools get their own child span;
 * basic tools (Bash/Read/Write/…) only increment a counter attribute
 * on the invocation span to avoid flooding the trace tree.
 *
 * F153 Phase J KD-40: uses `isMcpToolName` from `tool-usage/classify.ts` instead
 * of the previous local `isMcpTool`, which recognized only `cat_cafe_` / `mcp__` /
 * `signal_` but missed Codex `mcp:` prefix.
 */
export function recordToolUseSpan(
  invocationSpan: Span,
  catId: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
): void {
  if (!isMcpToolName(toolName)) {
    const prev = (toolCallCounts.get(invocationSpan) ?? 0) + 1;
    toolCallCounts.set(invocationSpan, prev);
    invocationSpan.setAttribute('tool.basic_call_count', prev);
    return;
  }

  const parentCtx = trace.setSpan(context.active(), invocationSpan);
  const category = classifyToolCategory(toolName);
  const span = tracer.startSpan(
    `cat_cafe.tool_use ${toolName}`,
    {
      attributes: {
        [AGENT_ID]: catId,
        [TOOL_NAME]: toolName,
        ...(toolInput ? { [TOOL_INPUT_KEYS]: Object.keys(toolInput).join(',') } : {}),
        ...(category ? { [TOOL_CATEGORY]: category } : {}),
      },
    },
    parentCtx,
  );
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

const toolCallCounts = new WeakMap<Span, number>();

/** @deprecated Use recordToolUseSpan instead. Kept for backward compat during migration. */
export const recordToolUseEvent = recordToolUseSpan;

// --- F153 Phase I: cat_cafe.agent_loop marker ---

const agentLoopCounts = new WeakMap<Span, number>();

/**
 * Record one completed agent loop (think → act → observe) on the invocation span.
 *
 * Provider stream parsers should call this at every LLM call boundary they can
 * identify from their stream protocol. The cumulative count is stored as the
 * `agent_loop.count` attribute on invocationSpan (same WeakMap + setAttribute
 * pattern as `tool.basic_call_count`), so Step Summary can derive
 * `agent_loop_count` per-route = sum across child invocation spans.
 *
 * Provider-agnostic: does NOT depend on `msg.metadata.usage.durationApiMs` or
 * the `done` event (both are per-invocation, not per-loop — see F153 KD-33).
 *
 * Providers that cannot identify LLM call boundaries from their stream simply
 * never call this helper; the invocation span has no `agent_loop.count`
 * attribute, and Step Summary displays `—` (per AC-I2, AC-I7 — non-degradation
 * to invocation count).
 */
export function recordAgentLoop(invocationSpan: Span): void {
  const prev = (agentLoopCounts.get(invocationSpan) ?? 0) + 1;
  agentLoopCounts.set(invocationSpan, prev);
  invocationSpan.setAttribute('agent_loop.count', prev);
}

/**
 * Stamp routing decision attributes onto the invocation span.
 * Not a separate span — routing is instantaneous and should live
 * on the same trace as the invocation it triggers.
 */
export function recordRoutingDecision(
  invocationSpan: Span,
  targetCats: string[],
  intent: string,
  strategy: 'parallel' | 'serial',
): void {
  invocationSpan.setAttribute(ROUTING_TARGET_CATS, targetCats.join(','));
  invocationSpan.setAttribute(ROUTING_INTENT, intent);
  invocationSpan.setAttribute(ROUTING_STRATEGY, strategy);
}
