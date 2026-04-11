/**
 * F152: TelemetryRedactor — OTel SpanProcessor & LogRecordProcessor
 * that enforces D1 field classification (Class A/B/C/D) on external telemetry.
 *
 * Internal (local logs/archive) remains untouched.
 * External (OTel exporters) gets filtered through this module.
 */

import { createHash } from 'node:crypto';
import type { Context } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { pseudonymizeId } from './hmac.js';

// --- Class A: credentials — always redacted ---
const CLASS_A_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'token',
  'apikey',
  'api_key',
  'secret',
  'password',
  'credential',
  'credentials',
  'callbacktoken',
]);

function isClassA(key: string): boolean {
  const lower = key.toLowerCase();
  return CLASS_A_KEYS.has(lower) || lower.endsWith('_token') || lower.endsWith('_api_key');
}

// --- Class B: business content — hash+length only ---
const CLASS_B_KEYS = new Set([
  'prompt',
  'message.content',
  'thinking',
  'toolinput',
  'tool_result',
  'command',
  'aggregated_output',
  'mcp.arguments',
  'rich_block.image',
]);

function isClassB(key: string): boolean {
  return CLASS_B_KEYS.has(key.toLowerCase());
}

// --- Class C: system identifiers — HMAC pseudonymized ---
const CLASS_C_KEYS = new Set(['userid', 'threadid', 'invocationid', 'sessionid', 'messageid', 'rawarchivepath']);

function isClassC(key: string): boolean {
  return CLASS_C_KEYS.has(key.toLowerCase());
}

function redactValue(key: string, value: unknown): unknown {
  if (isClassA(key)) return '[REDACTED]';
  if (isClassB(key) && typeof value === 'string') {
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    return `[hash:${hash} len:${value.length}]`;
  }
  if (isClassC(key) && typeof value === 'string') {
    return pseudonymizeId(value);
  }
  return value; // Class D: pass through
}

function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[key] = redactValue(key, value);
  }
  return result;
}

/**
 * OTel SpanProcessor that redacts span attributes before export.
 * Wraps an inner processor (typically a BatchSpanProcessor).
 */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: import('@opentelemetry/sdk-trace-node').Span, ctx: Context): void {
    this.inner.onStart(span, ctx);
  }

  onEnd(span: ReadableSpan): void {
    const redacted = redactAttributes(span.attributes as Record<string, unknown>);
    // ReadableSpan.attributes is readonly; we mutate before export via
    // a proxy object that the inner processor serializes.
    Object.assign((span as unknown as Record<string, unknown>).attributes ?? {}, redacted);
    this.inner.onEnd(span);
  }

  async shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}

/**
 * OTel LogRecordProcessor that redacts log record attributes before export.
 */
export class RedactingLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(record: SdkLogRecord, ctx?: Context): void {
    const attrs = (record as unknown as Record<string, unknown>).attributes;
    if (attrs && typeof attrs === 'object') {
      const redacted = redactAttributes(attrs as Record<string, unknown>);
      Object.assign(attrs, redacted);
    }
    this.inner.onEmit(record, ctx);
  }

  async shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}

// Export classification helpers for testing
export { isClassA, isClassB, isClassC, redactValue, redactAttributes };
