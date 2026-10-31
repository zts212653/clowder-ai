/**
 * F153 Phase B: Runtime tracing tests for llm_call spans, tool_use spans,
 * and RedactingSpanProcessor end-to-end.
 *
 * Tests call the actual instrumentation helpers (recordLlmCallSpan,
 * recordToolUseSpan) and RedactingSpanProcessor — not raw OTel API.
 *
 * Complements otel-tracing-runtime.test.js (cli_session spans).
 * Requires dist/ build — run `pnpm build` in packages/api first.
 */

// Ensure HMAC fallback salt is available (CI test:public may not set NODE_ENV)
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { trace, SpanStatusCode } = await import('@opentelemetry/api');
const { InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

// Module under test — actual instrumentation helpers used by invoke-single-cat.ts
const { recordLlmCallSpan, recordToolUseSpan } = await import('../../dist/infrastructure/telemetry/span-helpers.js');
const { RedactingSpanProcessor } = await import('../../dist/infrastructure/telemetry/redactor.js');

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

// ── recordLlmCallSpan tests ─────────────────────────────────────────

test('F153 runtime: recordLlmCallSpan produces child of invocation span', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordLlmCallSpan(invocationSpan, 'opus', 'anthropic', 'claude-sonnet-4-20250514', {
    durationApiMs: 1500,
    inputTokens: 1000,
    outputTokens: 200,
  });

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

test('F153 runtime: recordLlmCallSpan sets GenAI semantic attributes', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordLlmCallSpan(invocationSpan, 'opus', 'anthropic', 'claude-sonnet-4-20250514', {
    durationApiMs: 2000,
    inputTokens: 1500,
    outputTokens: 350,
    cacheReadTokens: 800,
  });

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

test('F153 runtime: recordLlmCallSpan omits zero-value token attrs', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordLlmCallSpan(invocationSpan, 'opus', 'anthropic', 'claude-sonnet-4-20250514', {
    durationApiMs: 500,
  });

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const llm = spans.find((s) => s.name === 'cat_cafe.llm_call');
  assert.ok(llm);
  const attrKeys = Object.keys(llm.attributes);
  assert.ok(!attrKeys.includes('gen_ai.usage.input_tokens'), 'Should omit missing inputTokens');
  assert.ok(!attrKeys.includes('gen_ai.usage.output_tokens'), 'Should omit missing outputTokens');
  assert.ok(!attrKeys.includes('gen_ai.usage.cache_read_tokens'), 'Should omit missing cacheReadTokens');
});

test('F153 runtime: recordLlmCallSpan sets retrospective startTime', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');
  const before = Date.now();

  recordLlmCallSpan(invocationSpan, 'opus', 'anthropic', 'claude-sonnet-4-20250514', {
    durationApiMs: 2000,
  });

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const llm = spans.find((s) => s.name === 'cat_cafe.llm_call');
  assert.ok(llm);
  const startMs = llm.startTime[0] * 1000 + llm.startTime[1] / 1e6;
  const expectedMs = before - 2000;
  assert.ok(Math.abs(startMs - expectedMs) < 100, 'Retrospective startTime should be ~2s before now');
});

// ── recordToolUseSpan tests (tiered: MCP → child span, basic → counter) ──

test('F153 runtime: recordToolUseSpan creates child span for MCP tools', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordToolUseSpan(invocationSpan, 'opus', 'cat_cafe_post_message', {
    threadId: 'thread_abc',
    content: 'hello',
  });

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.name.startsWith('cat_cafe.tool_use'));
  assert.ok(toolSpan, 'Should create cat_cafe.tool_use child span for MCP tool');
  assert.equal(toolSpan.attributes['tool.name'], 'cat_cafe_post_message');
  assert.equal(toolSpan.attributes['tool.input_keys'], 'threadId,content');
  assert.equal(toolSpan.attributes['agent.id'], 'opus');
});

test('F153 runtime: recordToolUseSpan increments counter for basic tools', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordToolUseSpan(invocationSpan, 'opus', 'Bash');
  recordToolUseSpan(invocationSpan, 'opus', 'Read');
  recordToolUseSpan(invocationSpan, 'opus', 'Edit');

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const inv = spans.find((s) => s.name === 'cat_cafe.invocation');
  assert.ok(inv);
  assert.equal(inv.attributes['tool.basic_call_count'], 3, 'Should count 3 basic tool calls');
  const toolSpans = spans.filter((s) => s.name === 'cat_cafe.tool_use');
  assert.equal(toolSpans.length, 0, 'Should NOT create spans for basic tools');
});

test('F153 runtime: recordToolUseSpan classifies memory tools', async () => {
  exporter.reset();
  const tracer = trace.getTracer('cat-cafe-api-test');
  const invocationSpan = tracer.startSpan('cat_cafe.invocation');

  recordToolUseSpan(invocationSpan, 'opus', 'cat_cafe_search_evidence', { query: 'test' });

  invocationSpan.end();

  const spans = exporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.name.startsWith('cat_cafe.tool_use'));
  assert.ok(toolSpan, 'Memory tool should get a child span');
  assert.equal(toolSpan.attributes['tool.category'], 'memory', 'Should be classified as memory tool');
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

  // Class C: values must be transformed (not raw) and be hex strings
  assert.notEqual(a['invocationId'], 'inv-secret-123', 'invocationId must not be raw');
  assert.match(String(a['invocationId']), /^[0-9a-f]{32}$/, 'invocationId should be 32-char hex HMAC');
  assert.notEqual(a['sessionId'], 'sess-secret-456', 'sessionId must not be raw');
  assert.match(String(a['sessionId']), /^[0-9a-f]{32}$/, 'sessionId should be 32-char hex HMAC');
  // Class D: pass through unchanged
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
