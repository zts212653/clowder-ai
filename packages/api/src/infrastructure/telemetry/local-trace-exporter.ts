/**
 * F153 Phase E: LocalTraceExporter — custom SpanExporter that projects
 * redacted spans into DTOs and stores them in the LocalTraceStore ring buffer.
 *
 * MUST be placed AFTER RedactingSpanProcessor in the span processor chain
 * so it only sees redacted attributes. The chain order is:
 *
 *   1. ConsoleSpanExporter (debug, unredacted)
 *   2. RedactingSpanProcessor(OTLP) — mutates span.attributes in-place
 *   3. SimpleSpanProcessor(LocalTraceExporter) — sees redacted attributes ← this
 */

import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import type { TraceSpanDTO } from './local-trace-store.js';
import { LocalTraceStore } from './local-trace-store.js';

/** Convert an OTel HrTime [seconds, nanoseconds] to Unix milliseconds. */
function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/** Project a ReadableSpan into a lightweight DTO (deep-copy attributes). */
function spanToDTO(span: ReadableSpan): TraceSpanDTO {
  const startTimeMs = hrTimeToMs(span.startTime);
  const endTimeMs = hrTimeToMs(span.endTime);

  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId:
      (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId || undefined,
    name: span.name,
    kind: span.kind,
    startTimeMs,
    endTimeMs,
    durationMs: endTimeMs - startTimeMs,
    status: {
      code: span.status.code,
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({
      name: e.name,
      timeMs: hrTimeToMs(e.time),
      ...(e.attributes && Object.keys(e.attributes).length > 0 ? { attributes: { ...e.attributes } } : {}),
    })),
    storedAt: Date.now(),
  };
}

export class LocalTraceExporter implements SpanExporter {
  private readonly store: LocalTraceStore;
  private _shutdown = false;

  constructor(store?: LocalTraceStore) {
    this.store = store ?? new LocalTraceStore();
  }

  /** Get the backing store (for route injection). */
  getStore(): LocalTraceStore {
    return this.store;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this._shutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    for (const span of spans) {
      this.store.add(spanToDTO(span));
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
  }

  async forceFlush(): Promise<void> {
    // No-op — in-memory store, nothing to flush
  }
}

// Re-export for convenience
export { spanToDTO, hrTimeToMs };
