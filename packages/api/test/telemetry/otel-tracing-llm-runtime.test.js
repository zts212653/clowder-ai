/**
 * F153 Phase B: Runtime tracing tests for llm_call spans, tool_use events,
 * and RedactingSpanProcessor end-to-end.
 *
 * Complements otel-tracing-runtime.test.js (cli_session spans).
 * Requires dist/ build — run `pnpm build` in packages/api first.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { trace, SpanStatusCode, context } = await import('@opentelemetry/api');
const { InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const { RedactingSpanProcessor } = await import('../../dist/infrastructure/telemetry/redactor.js');
const { hmacId } = await import('../../dist/infrastructure/telemetry/hmac.js');

// --- Primary provider: unredacted spans ---
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

// --- Secondary provider: redacted spans (for Class C tests) ---
const redactedExporter = new InMemorySpanExporter();
const redactedProvider = new NodeTracerProvider({
  spanProcessors: [new RedactingSpanProcessor(new SimpleSpanProcessor(redactedExporter))],
});

// ── llm_call span tests ─────────────────────────────────────────────

test('F153 runtime: llm_call span is child of invocation span', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-llm-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  const parentCtx = trace.setSpan(context.active(), invocationSpan);
  const llmSpan = tracer.startSpan(
    'cat_cafe.llm_call',
    {
      attributes: {
        'agent.id': 'opus',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    parentCtx,
  );
  llmSpan.setStatus({ code: SpanStatusCode.OK });
  llmSpan.end();
  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const llm = spans.find((s) => s.name === 'cat_cafe.llm_call');
  assert.ok(llm, 'Should produce cat_cafe.llm_call span');
  assert.equal(
    llm.parentSpanContext.spanId,
    invocationSpan.spanContext().spanId,
    'llm_call should be child of invocation',
  );
});

test('F153 runtime: llm_call span carries GenAI semantic attributes', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-llm-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');
  const parentCtx = trace.setSpan(context.active(), invocationSpan);

  const llmSpan = tracer.startSpan(
    'cat_cafe.llm_call',
    {
      attributes: {
        'agent.id': 'opus',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 1500,
        'gen_ai.usage.output_tokens': 350,
        'gen_ai.usage.cache_read_tokens': 800,
      },
    },
    parentCtx,
  );
  llmSpan.setStatus({ code: SpanStatusCode.OK });
  llmSpan.end();
  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const llm = spans.find((s) => s.name === 'cat_cafe.llm_call');
  assert.ok(llm);

  const a = llm.attributes;
  assert.equal(a['agent.id'], 'opus');
  assert.equal(a['gen_ai.system'], 'anthropic');
  assert.equal(a['gen_ai.request.model'], 'claude-sonnet-4-20250514');
  assert.equal(a['gen_ai.usage.input_tokens'], 1500);
  assert.equal(a['gen_ai.usage.output_tokens'], 350);
  assert.equal(a['gen_ai.usage.cache_read_tokens'], 800);
});

test('F153 runtime: llm_call span respects retrospective startTime', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-llm-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');
  const parentCtx = trace.setSpan(context.active(), invocationSpan);

  const durationMs = 2000;
  const spanStartTime = new Date(Date.now() - durationMs);

  const llmSpan = tracer.startSpan(
    'cat_cafe.llm_call',
    {
      attributes: { 'agent.id': 'opus', 'gen_ai.system': 'anthropic' },
      startTime: spanStartTime,
    },
    parentCtx,
  );
  llmSpan.setStatus({ code: SpanStatusCode.OK });
  llmSpan.end();
  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const llm = spans.find((s) => s.name === 'cat_cafe.llm_call');
  assert.ok(llm);
  const startHr = llm.startTime;
  const startMs = startHr[0] * 1000 + startHr[1] / 1e6;
  const expectedMs = spanStartTime.getTime();
  assert.ok(Math.abs(startMs - expectedMs) < 50, 'Retrospective startTime should be within 50ms');
});

// ── tool_use event tests ─────────────────────────────────────────────

test('F153 runtime: tool_use recorded as span event with correct attrs', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-llm-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  invocationSpan.addEvent('tool_use', {
    'agent.id': 'opus',
    'tool.name': 'cat_cafe_post_message',
    'tool.input_keys': 'threadId,content',
  });

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const inv = spans.find((s) => s.name === 'cat_cafe.invocation');
  assert.ok(inv);
  assert.equal(inv.events.length, 1, 'Should have exactly one event');

  const evt = inv.events[0];
  assert.equal(evt.name, 'tool_use');
  assert.equal(evt.attributes['agent.id'], 'opus');
  assert.equal(evt.attributes['tool.name'], 'cat_cafe_post_message');
  assert.equal(evt.attributes['tool.input_keys'], 'threadId,content');
});

test('F153 runtime: multiple tool_use events accumulate on span', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-llm-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  invocationSpan.addEvent('tool_use', { 'tool.name': 'Read' });
  invocationSpan.addEvent('tool_use', { 'tool.name': 'Edit' });
  invocationSpan.addEvent('tool_use', { 'tool.name': 'Bash' });
  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const inv = spans.find((s) => s.name === 'cat_cafe.invocation');
  assert.ok(inv);
  assert.equal(inv.events.length, 3, 'Should have three tool_use events');
  assert.deepEqual(
    inv.events.map((e) => e.attributes['tool.name']),
    ['Read', 'Edit', 'Bash'],
  );
});

// ── RedactingSpanProcessor end-to-end ────────────────────────────────

test('F153 runtime: RedactingSpanProcessor pseudonymizes Class C attrs', async () => {
  redactedExporter.reset();
  const tracer = redactedProvider.getTracer('cat-cafe-redact-test');

  const span = tracer.startSpan('cat_cafe.cli_session', {
    attributes: {
      invocationId: 'inv-secret-123',
      sessionId: 'sess-secret-456',
      'cli.command': 'claude',
      'cli.pid': 99999,
    },
  });
  span.end();

  const spans = redactedExporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  const a = spans[0].attributes;

  const expectedInvId = hmacId('inv-secret-123');
  const expectedSessId = hmacId('sess-secret-456');
  assert.equal(a['invocationId'], expectedInvId, 'invocationId should be HMAC pseudonymized');
  assert.equal(a['sessionId'], expectedSessId, 'sessionId should be HMAC pseudonymized');
  assert.equal(a['cli.command'], 'claude', 'Class D attr should pass through');
  assert.equal(a['cli.pid'], 99999, 'Class D numeric attr should pass through');
});

test('F153 runtime: RedactingSpanProcessor redacts Class A credentials', async () => {
  redactedExporter.reset();
  const tracer = redactedProvider.getTracer('cat-cafe-redact-test');

  const span = tracer.startSpan('test.span', {
    attributes: { authorization: 'Bearer sk-1234', 'x-api-key': 'key-5678' },
  });
  span.end();

  const spans = redactedExporter.getFinishedSpans();
  const a = spans[0].attributes;
  assert.equal(a['authorization'], '[REDACTED]', 'Class A should be [REDACTED]');
  assert.equal(a['x-api-key'], '[REDACTED]', 'Class A x-api-key should be [REDACTED]');
});

test('F153 runtime: RedactingSpanProcessor hashes Class B content', async () => {
  redactedExporter.reset();
  const tracer = redactedProvider.getTracer('cat-cafe-redact-test');

  const span = tracer.startSpan('test.span', {
    attributes: { prompt: 'Hello, this is a secret prompt' },
  });
  span.end();

  const spans = redactedExporter.getFinishedSpans();
  const val = spans[0].attributes['prompt'];
  assert.ok(typeof val === 'string');
  assert.match(val, /^\[hash:[0-9a-f]{16} len:\d+\]$/, 'Class B should be [hash:HEX len:N]');
});
