/**
 * F153 Phase B: Extracted span creation helpers for llm_call and tool_use.
 *
 * Previously inlined in invoke-single-cat.ts. Extracted here so the
 * instrumentation logic is testable independently of the full invocation flow.
 */

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { AGENT_ID, GENAI_MODEL, GENAI_SYSTEM } from './genai-semconv.js';

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
      },
      startTime: spanStartTime,
    },
    parentCtx,
  );
  llmSpan.setStatus({ code: SpanStatusCode.OK });
  llmSpan.end();
}

/**
 * Record a tool_use event on the invocation span.
 * Events (not child spans) because no duration data is available.
 */
export function recordToolUseEvent(
  invocationSpan: Span,
  catId: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
): void {
  invocationSpan.addEvent('tool_use', {
    [AGENT_ID]: catId,
    'tool.name': toolName,
    ...(toolInput ? { 'tool.input_keys': Object.keys(toolInput).join(',') } : {}),
  });
}
