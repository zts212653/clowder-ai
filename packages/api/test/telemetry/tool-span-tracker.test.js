/**
 * F153 Phase J Slice J-A AC-J6: behavioral tests for ToolSpanTracker.
 *
 * Coverage matrix (from spec):
 * (a) Two same-name tools in parallel — Map<toolUseId> keeps them separate
 * (b) Result arrives out-of-order — span correctly paired by toolUseId
 * (c) Error result → span status ERROR + tool.result.status='error'
 * (d) Abort orphan cleanup → endAllOrphans marks tool.lifecycle='aborted'
 * (e) Codex mcp: classification correct — span emitted (not basic counter)
 *
 * Plus edge cases:
 * - Basic tool bumps tool.basic_call_count, no span
 * - end() no-op for unknown toolUseId
 * - Duplicate start returns existing span (no double-create)
 * - isMcpToolName covers all 4 patterns
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Source-string sanity: spec implementation contract ─────────────

test('F153 Phase J AC-J3: tool-span-tracker.ts exports ToolSpanTracker class', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/tool-span-tracker.ts'), 'utf8');
  assert.ok(src.includes('export class ToolSpanTracker'), 'should export ToolSpanTracker class');
  assert.ok(
    src.includes('start(toolName: string, toolUseId: string'),
    'should have start(toolName, toolUseId, ...) API',
  );
  assert.ok(
    src.includes('end(toolUseId: string, status: ToolResultStatus)'),
    'should have end(toolUseId, status) API — no result body parameter (砚砚 R1 P2)',
  );
  assert.ok(src.includes('endAllOrphans('), 'should have endAllOrphans for AC-J4');
});

test('F153 Phase J AC-J5: span-helpers uses isMcpToolName from classify.ts', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/span-helpers.ts'), 'utf8');
  assert.ok(
    src.includes("import { isMcpToolName } from '../../domains/cats/services/tool-usage/classify.js'"),
    'span-helpers should import isMcpToolName',
  );
  assert.ok(!src.includes('function isMcpTool('), 'local isMcpTool function should be removed');
});

test('F153 Phase J AC-J1: AgentMessage has toolUseId + toolResultStatus fields', () => {
  const src = readFileSync(resolve(__dirname, '../../src/domains/cats/services/types.ts'), 'utf8');
  assert.ok(src.includes('toolUseId?: string'), 'AgentMessage should declare toolUseId optional field');
  assert.ok(
    src.includes("toolResultStatus?: 'ok' | 'error' | 'unknown'"),
    'AgentMessage should declare toolResultStatus with 3-value union',
  );
});

test('F153 Phase J AC-J5: isMcpToolName recognizes all 4 patterns (mcp__ / mcp: / cat_cafe_ / signal_)', async () => {
  const { isMcpToolName } = await import('../../dist/domains/cats/services/tool-usage/classify.js');
  assert.equal(isMcpToolName('mcp__cat-cafe__cat_cafe_post_message'), true, 'Claude wrapping');
  assert.equal(isMcpToolName('mcp:cat-cafe/post_message'), true, 'Codex wrapping (the gap fix)');
  assert.equal(isMcpToolName('cat_cafe_search_evidence'), true, 'bare cat_cafe_');
  assert.equal(isMcpToolName('signal_search'), true, 'bare signal_');
  assert.equal(isMcpToolName('Bash'), false, 'basic tool');
  assert.equal(isMcpToolName('Read'), false, 'basic tool');
});

// ── Behavioral: ToolSpanTracker lifecycle (real OTel exporter) ──────

const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const otelExporter = new InMemorySpanExporter();
const otelProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
});
otelProvider.register();
const otelTracer = otelProvider.getTracer('tool-span-tracker-test');

const { ToolSpanTracker } = await import('../../dist/infrastructure/telemetry/tool-span-tracker.js');

test('F153 Phase J AC-J3 behavioral: tracker creates real-duration span paired by toolUseId', async () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'use-1', { content: 'hi' });
  await new Promise((r) => setTimeout(r, 10));
  tracker.end('use-1', 'ok');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.name === 'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_post_message');
  assert.ok(toolSpan, 'tool_use span should be present');
  assert.ok(toolSpan.duration[1] > 0 || toolSpan.duration[0] > 0, 'span should have non-zero duration');
  assert.equal(toolSpan.attributes['tool.use_id'], 'use-1', 'tool.use_id attribute set');
  assert.equal(toolSpan.attributes['tool.result.status'], 'ok', 'tool.result.status set');
  assert.equal(toolSpan.status.code, 1, 'span status OK');
});

test('F153 Phase J AC-J6(a): two same-name tools in parallel — both tracked separately', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp:cat-cafe/post_message', 'use-A', {});
  tracker.start('mcp:cat-cafe/post_message', 'use-B', {});
  assert.equal(tracker.size(), 2, 'two spans open with same tool name, different ids');

  tracker.end('use-A', 'ok');
  tracker.end('use-B', 'ok');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpans = spans.filter((s) => s.name.includes('post_message'));
  assert.equal(toolSpans.length, 2, 'both tool spans flushed');
  const ids = new Set(toolSpans.map((s) => s.attributes['tool.use_id']));
  assert.deepEqual([...ids].sort(), ['use-A', 'use-B'], 'distinct tool.use_id attributes');
});

test('F153 Phase J AC-J6(b): result arrives out-of-order — correct span paired by toolUseId', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'first', {});
  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'second', {});
  tracker.end('second', 'error'); // out of order: second result before first
  tracker.end('first', 'ok');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const firstSpan = spans.find((s) => s.attributes['tool.use_id'] === 'first');
  const secondSpan = spans.find((s) => s.attributes['tool.use_id'] === 'second');
  assert.equal(firstSpan.attributes['tool.result.status'], 'ok', 'first paired with ok');
  assert.equal(secondSpan.attributes['tool.result.status'], 'error', 'second paired with error');
});

test('F153 Phase J AC-J6(c): error result sets span status ERROR + tool.result.status=error', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'use-err', {});
  tracker.end('use-err', 'error');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.attributes['tool.use_id'] === 'use-err');
  assert.equal(toolSpan.status.code, 2, 'OTel status ERROR (code=2)');
  assert.equal(toolSpan.attributes['tool.result.status'], 'error', 'tool.result.status=error attribute');
  // 砚砚 R1 P2: tracker.end deliberately does NOT accept result body / resultMeta.
  // Per spec "Out of scope: Tool input/result body 写入 span attr — 保持低敏".
  // Only the structured status is attached; freeform fields would bypass redactor coverage.
  assert.equal(toolSpan.attributes['tool.result.errorMessage'], undefined, 'no freeform result body in span attrs');
});

test('F153 Phase J AC-J3 (砚砚 R1 P3): tool_use span is child of invocation span (parent-child wiring)', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'use-parent-check', {});
  tracker.end('use-parent-check', 'ok');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.attributes['tool.use_id'] === 'use-parent-check');
  assert.ok(toolSpan, 'tool span should be present');
  // Hub trace tree relies on parentSpanId pointing at invocation span — this is the
  // contract that makes the tool show up as a child node, not as an orphan trace.
  assert.equal(
    toolSpan.parentSpanContext?.spanId ?? toolSpan.parentSpanId,
    invocationSpan.spanContext().spanId,
    'tool span parent must be invocation span (Hub trace tree contract)',
  );
  assert.equal(
    toolSpan.spanContext().traceId,
    invocationSpan.spanContext().traceId,
    'tool span shares invocation trace id',
  );
});

test('F153 Phase J AC-J6(d) / AC-J4: endAllOrphans marks unresolved spans as aborted', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'use-1', {});
  tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'use-2', {});
  tracker.end('use-1', 'ok');
  // use-2 result never arrives
  tracker.endAllOrphans('aborted');
  assert.equal(tracker.size(), 0, 'all spans cleaned up');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const orphan = spans.find((s) => s.attributes['tool.use_id'] === 'use-2');
  assert.equal(orphan.attributes['tool.lifecycle'], 'aborted', 'orphan marked aborted');
});

test('F153 Phase J AC-J6(e): Codex mcp: classified as MCP (span emitted, not basic counter)', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'codex');

  tracker.start('mcp:cat-cafe/post_message', 'use-codex', { content: 'hello' });
  tracker.end('use-codex', 'ok');
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const codexSpan = spans.find((s) => s.attributes['tool.use_id'] === 'use-codex');
  assert.ok(codexSpan, 'mcp: tool MUST emit a child span (KD-40 fix)');
  assert.equal(codexSpan.name, 'cat_cafe.tool_use mcp:cat-cafe/post_message');
});

test('F153 Phase J: basic tool bumps tool.basic_call_count, no child span', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  tracker.start('Bash', 'use-bash-1', { command: 'ls' });
  tracker.start('Read', 'use-read-1', { path: '/tmp' });
  tracker.start('Bash', 'use-bash-2', { command: 'pwd' });
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpans = spans.filter((s) => s.name.startsWith('cat_cafe.tool_use '));
  assert.equal(toolSpans.length, 0, 'no child spans for basic tools');
  assert.equal(invocationSpan.attributes['tool.basic_call_count'], 3, 'counter bumped 3 times');
});

test('F153 Phase J: end() no-op for unknown toolUseId (basic tool or unmatched result)', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  // Never started — end is silent no-op
  tracker.end('never-started', 'ok');
  assert.equal(tracker.size(), 0);
  invocationSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const toolSpans = spans.filter((s) => s.name.startsWith('cat_cafe.tool_use '));
  assert.equal(toolSpans.length, 0, 'no spurious span created');
});

test('F153 Phase J: duplicate start returns existing span (no double-create)', () => {
  otelExporter.reset();
  const invocationSpan = otelTracer.startSpan('cat_cafe.invocation');
  const tracker = new ToolSpanTracker(invocationSpan, 'opus');

  const span1 = tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'dup', {});
  const span2 = tracker.start('mcp__cat-cafe__cat_cafe_post_message', 'dup', {});
  assert.strictEqual(span1, span2, 'duplicate start returns existing span');
  assert.equal(tracker.size(), 1, 'only one span open');

  tracker.end('dup', 'ok');
  invocationSpan.end();
});
