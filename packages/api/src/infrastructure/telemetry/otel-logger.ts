/**
 * F152: OTel Logger bridge — emits structured log records through the
 * OTel log pipeline (RedactingLogProcessor → exporter).
 *
 * This does NOT replace Pino for local logs. It provides a parallel
 * emission path so that key events flow through OTel's log signal,
 * enabling correlation with traces and metrics in external backends.
 *
 * Trace-log correlation: caller passes the active Span; we derive a
 * Context via trace.setSpan() and pass it as LogRecord.context, which
 * is the OTel-standard way to link log records to spans.
 */

import { context, type Span, trace } from '@opentelemetry/api';
import { type LogAttributes, logs, SeverityNumber } from '@opentelemetry/api-logs';

const logger = logs.getLogger('cat-cafe-api', '0.1.0');

/**
 * Emit a structured log record through the OTel log pipeline.
 * Pass the active span to get proper trace-log correlation via
 * LogRecord.context (not manual traceId/spanId attributes).
 */
export function emitOtelLog(
  severity: 'INFO' | 'WARN' | 'ERROR',
  body: string,
  attributes?: LogAttributes,
  span?: Span,
): void {
  const severityMap: Record<string, SeverityNumber> = {
    INFO: SeverityNumber.INFO,
    WARN: SeverityNumber.WARN,
    ERROR: SeverityNumber.ERROR,
  };

  // Build context from span for OTel trace-log correlation
  const logContext = span ? trace.setSpan(context.active(), span) : undefined;

  logger.emit({
    severityNumber: severityMap[severity],
    severityText: severity,
    body,
    attributes,
    context: logContext,
  });
}
