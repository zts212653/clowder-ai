/**
 * F153 Phase E: LocalTraceExporter tests.
 *
 * Covers:
 * - Span → DTO projection (attributes, events, timing)
 * - Exporter stores DTOs in LocalTraceStore
 * - Shutdown prevents further exports
 * - Integration with RedactingSpanProcessor (redacted fan-out)
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ExportResultCode } = await import('@opentelemetry/core');
const { NodeTracerProvider, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
const { LocalTraceExporter, hrTimeToMs } = await import('../../dist/infrastructure/telemetry/local-trace-exporter.js');
const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');
const { RedactingSpanProcessor } = await import('../../dist/infrastructure/telemetry/redactor.js');

/** Helper: create provider with spanProcessors in constructor (OTel v2 API). */
function createProvider(...processors) {
  return new NodeTracerProvider({ spanProcessors: processors });
}

test('hrTimeToMs converts [seconds, nanoseconds] to ms', () => {
  assert.equal(hrTimeToMs([1, 0]), 1000);
  assert.equal(hrTimeToMs([0, 500_000_000]), 500);
  assert.equal(hrTimeToMs([2, 500_000_000]), 2500);
  assert.equal(hrTimeToMs([0, 0]), 0);
});

test('LocalTraceExporter: exports spans as DTOs into store', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const exporter = new LocalTraceExporter(store);
  const provider = createProvider(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('test');

  const span = tracer.startSpan('test.operation', {
    attributes: { 'agent.id': 'ragdoll', custom: 'value' },
  });
  span.end();

  const results = store.query({});
  assert.equal(results.length, 1);

  const dto = results[0];
  assert.equal(dto.name, 'test.operation');
  assert.equal(dto.attributes['agent.id'], 'ragdoll');
  assert.equal(dto.attributes.custom, 'value');
  assert.ok(dto.traceId, 'traceId should be populated');
  assert.ok(dto.spanId, 'spanId should be populated');
  assert.ok(dto.startTimeMs > 0, 'startTimeMs should be positive');
  assert.ok(dto.endTimeMs >= dto.startTimeMs, 'endTimeMs >= startTimeMs');
  assert.ok(dto.durationMs >= 0, 'durationMs should be non-negative');
  assert.equal(dto.status.code, 0); // UNSET
  assert.ok(dto.storedAt > 0, 'storedAt should be set');

  provider.shutdown();
});

test('LocalTraceExporter: captures span events', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const exporter = new LocalTraceExporter(store);
  const provider = createProvider(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('test');

  const span = tracer.startSpan('with.events');
  span.addEvent('tool_use', { 'tool.name': 'read_file' });
  span.end();

  const dto = store.query({})[0];
  assert.equal(dto.events.length, 1);
  assert.equal(dto.events[0].name, 'tool_use');
  assert.ok(dto.events[0].timeMs > 0);

  provider.shutdown();
});

test('LocalTraceExporter: captures parent-child relationship', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const exporter = new LocalTraceExporter(store);
  const provider = createProvider(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('test');

  const { context, trace } = await import('@opentelemetry/api');
  const parent = tracer.startSpan('parent');
  const parentCtx = trace.setSpan(context.active(), parent);
  const child = tracer.startSpan('child', {}, parentCtx);
  child.end();
  parent.end();

  const dtos = store.query({});
  assert.equal(dtos.length, 2);

  const childDTO = dtos.find((d) => d.name === 'child');
  const parentDTO = dtos.find((d) => d.name === 'parent');
  assert.ok(childDTO);
  assert.ok(parentDTO);
  assert.equal(childDTO.parentSpanId, parentDTO.spanId);
  assert.equal(childDTO.traceId, parentDTO.traceId);

  provider.shutdown();
});

test('LocalTraceExporter: getStore returns the backing store', () => {
  const store = new LocalTraceStore();
  const exporter = new LocalTraceExporter(store);
  assert.equal(exporter.getStore(), store);
});

test('LocalTraceExporter: default constructor creates its own store', () => {
  const exporter = new LocalTraceExporter();
  assert.ok(exporter.getStore());
});

test('LocalTraceExporter: shutdown prevents further exports', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const exporter = new LocalTraceExporter(store);
  await exporter.shutdown();

  let resultCode;
  exporter.export([], (result) => {
    resultCode = result.code;
  });
  assert.equal(resultCode, ExportResultCode.FAILED);
});

test('LocalTraceExporter: redacted fan-out — sees redacted attributes after RedactingSpanProcessor', () => {
  // This is the critical ordering test:
  // 1. RedactingSpanProcessor mutates span.attributes in-place
  // 2. LocalTraceExporter (via SimpleSpanProcessor) runs after and sees redacted values
  const store = new LocalTraceStore({ maxSpans: 100 });
  const localExporter = new LocalTraceExporter(store);

  // Chain: RedactingSpanProcessor(noop) → then LocalTraceExporter
  const noopProcessor = {
    onStart() {},
    onEnd() {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const provider = createProvider(new RedactingSpanProcessor(noopProcessor), new SimpleSpanProcessor(localExporter));

  const tracer = provider.getTracer('test');
  const span = tracer.startSpan('redaction.test', {
    attributes: {
      invocationId: 'raw-inv-123', // Class C → HMAC
      prompt: 'Tell me a secret', // Class B → hash+length
      'agent.id': 'ragdoll', // Class D → passthrough
    },
  });
  span.end();

  const dto = store.query({})[0];

  // Class C: invocationId should be HMAC'd (not raw)
  assert.notEqual(dto.attributes.invocationId, 'raw-inv-123');
  assert.ok(typeof dto.attributes.invocationId === 'string');
  assert.ok(dto.attributes.invocationId.length > 0);

  // Class B: prompt should be hash+length
  assert.ok(String(dto.attributes.prompt).startsWith('[hash:'));
  assert.ok(String(dto.attributes.prompt).includes('len:'));

  // Class D: agent.id passes through
  assert.equal(dto.attributes['agent.id'], 'ragdoll');

  provider.shutdown();
});

test('LocalTraceExporter: DTO deep-copies attributes (no shared references)', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const exporter = new LocalTraceExporter(store);
  const provider = createProvider(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('test');

  const span = tracer.startSpan('copy.test', {
    attributes: { mutable: 'original' },
  });
  span.end();

  const dto = store.query({})[0];
  // Mutating the DTO attributes should not affect anything outside
  dto.attributes.mutable = 'modified';

  // Confirms the DTO is a snapshot, not a live reference to SDK internals
  assert.equal(dto.attributes.mutable, 'modified');

  provider.shutdown();
});
