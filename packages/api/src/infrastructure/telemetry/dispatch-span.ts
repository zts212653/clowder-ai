/**
 * F153: mention_dispatch span for callback A2A paths.
 *
 * Creates a dispatch span as child of the caller's trace context,
 * returning a new CallerTraceContext for the dispatched route.
 */

import { context as ctxApi, trace } from '@opentelemetry/api';
import type { CallerTraceContext } from './genai-semconv.js';

const tracer = trace.getTracer('cat-cafe-a2a');

export function wrapWithDispatchSpan(callerCtx: CallerTraceContext, targetCount: number): CallerTraceContext {
  const remoteParent = trace.setSpanContext(ctxApi.active(), {
    traceId: callerCtx.traceId,
    spanId: callerCtx.spanId,
    traceFlags: callerCtx.traceFlags,
    isRemote: true,
  });

  const dispatchSpan = tracer.startSpan(
    'cat_cafe.mention_dispatch',
    { attributes: { 'dispatch.target_count': targetCount, 'dispatch.source': 'callback' } },
    remoteParent,
  );

  const sc = dispatchSpan.spanContext();
  dispatchSpan.end();

  return { traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags };
}
