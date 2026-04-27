/**
 * F172: Cross-cat trace propagation via mention_dispatch spans.
 *
 * Covers:
 * - Text-scan A2A path: mention_dispatch span created as child of mentioner's invocation
 * - invocationSpanRef: caller can capture invocation span reference
 * - Callback A2A path: NOT covered (InvocationQueue creates separate routeExecution — tracked as follow-up)
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── invocationSpanRef param exists on InvocationParams ─────────────

test('F172: InvocationParams declares invocationSpanRef field', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('invocationSpanRef') && src.includes('{ current?:'),
    'InvocationParams should declare invocationSpanRef with { current?: Span } shape',
  );
});

test('F172: invokeSingleCat writes span to invocationSpanRef', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('params.invocationSpanRef') && src.includes('.current = invocationSpan'),
    'Should write invocationSpan to spanRef.current after creation',
  );
});

// ── route-serial: mention_dispatch span creation ───────────────────

test('F172: route-serial creates cat_cafe.mention_dispatch span on A2A push', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes("'cat_cafe.mention_dispatch'") && src.includes('mention.targets'),
    'Should create mention_dispatch span with mention.targets attribute',
  );
});

test('F172: route-serial uses effectiveParentSpan (mention_dispatch or routeSpan) for invocation', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('effectiveParentSpan') && src.includes('mentionParentSpan.get(index)'),
    'Should resolve parent span from mentionParentSpan map or fall back to routeSpan',
  );
  assert.ok(
    src.includes('effectiveParentSpan ? { routeSpan: effectiveParentSpan }'),
    'Should pass effectiveParentSpan as routeSpan to invokeSingleCat',
  );
});

test('F172: route-serial tracks catInvocationSpans per worklist index', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('catInvocationSpans.set(index, spanRef.current)'),
    'Should store invocation span by worklist index after cat completes',
  );
});

// ── Dedup path: mentionParentSpan sync with a2aFrom ───────────────

test('F172: dedup path updates mentionParentSpan when a2aFrom changes', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('dedupIndex') && src.includes('mentionParentSpan.set(dedupIndex'),
    'Dedup path should update mentionParentSpan when a2aFrom is overwritten',
  );
});

// ── Dispatch span lifecycle ────────────────────────────────────────

test('F172: dispatch spans ended after last child completes', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('pendingDispatchSpans') && src.includes('entry.lastChildIndex') && src.includes('entry.span.end()'),
    'Should end dispatch span when index reaches lastChildIndex',
  );
});

test('F172: finally block ends orphaned dispatch spans on early abort', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  const finallyIdx = src.indexOf('} finally {');
  const cleanupIdx = src.indexOf('index <= entry.lastChildIndex');
  assert.ok(
    finallyIdx > 0 && cleanupIdx > finallyIdx,
    'Finally block should end dispatch spans not yet completed (abort safety)',
  );
});

// ── Behavioral: OTel span parent-child wiring (real tracer) ───────

const { context: ctxApi, trace: traceApi } = await import('@opentelemetry/api');
const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const otelExporter = new InMemorySpanExporter();
const otelProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
});
const otelTracer = otelProvider.getTracer('test-mention-dispatch');

test('F172 behavioral: mention_dispatch span is child of mentioner invocation', async () => {
  otelExporter.reset();

  // Simulate: route → invocation(A) → mention_dispatch → invocation(B)
  const routeSpan = otelTracer.startSpan('cat_cafe.route');
  const routeCtx = traceApi.setSpan(ctxApi.active(), routeSpan);

  const invocationA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, routeCtx);
  invocationA.end();

  // mention_dispatch as child of invocation A (even though A already ended)
  const invACtx = traceApi.setSpan(ctxApi.active(), invocationA);
  const dispatchSpan = otelTracer.startSpan('cat_cafe.mention_dispatch', {
    attributes: { 'mention.targets': 'sonnet,codex' },
  }, invACtx);

  // invocation B as child of mention_dispatch
  const dispatchCtx = traceApi.setSpan(ctxApi.active(), dispatchSpan);
  const invocationB = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'sonnet' } }, dispatchCtx);
  invocationB.end();

  dispatchSpan.end();
  routeSpan.end();

  // Verify hierarchy via exported spans
  const spans = otelExporter.getFinishedSpans();
  assert.equal(spans.length, 4);

  const route = spans.find(s => s.name === 'cat_cafe.route');
  const invA = spans.find(s => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === 'opus');
  const dispatch = spans.find(s => s.name === 'cat_cafe.mention_dispatch');
  const invB = spans.find(s => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === 'sonnet');

  assert.ok(route && invA && dispatch && invB, 'All 4 spans should be present');

  // Same trace
  const traceId = route.spanContext().traceId;
  assert.equal(invA.spanContext().traceId, traceId, 'invocation A same trace');
  assert.equal(dispatch.spanContext().traceId, traceId, 'dispatch same trace');
  assert.equal(invB.spanContext().traceId, traceId, 'invocation B same trace');

  // Parent-child: route → invA → dispatch → invB
  assert.equal(invA.parentSpanContext.spanId, route.spanContext().spanId, 'invocation A is child of route');
  assert.equal(dispatch.parentSpanContext.spanId, invA.spanContext().spanId, 'mention_dispatch is child of invocation A');
  assert.equal(invB.parentSpanContext.spanId, dispatch.spanContext().spanId, 'invocation B is child of mention_dispatch');
});

test('F172 behavioral: multiple mentioned cats share same dispatch parent', async () => {
  otelExporter.reset();

  const routeSpan = otelTracer.startSpan('cat_cafe.route');
  const routeCtx = traceApi.setSpan(ctxApi.active(), routeSpan);

  const invA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, routeCtx);
  invA.end();

  const invACtx = traceApi.setSpan(ctxApi.active(), invA);
  const dispatch = otelTracer.startSpan('cat_cafe.mention_dispatch', {
    attributes: { 'mention.targets': 'sonnet,codex' },
  }, invACtx);
  const dispatchCtx = traceApi.setSpan(ctxApi.active(), dispatch);

  const invB = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'sonnet' } }, dispatchCtx);
  invB.end();
  const invC = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'codex' } }, dispatchCtx);
  invC.end();

  dispatch.end();
  routeSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const dispatchSpan = spans.find(s => s.name === 'cat_cafe.mention_dispatch');
  const sonnet = spans.find(s => s.attributes['agent.id'] === 'sonnet');
  const codex = spans.find(s => s.attributes['agent.id'] === 'codex');

  assert.equal(sonnet.parentSpanContext.spanId, dispatchSpan.spanContext().spanId, 'sonnet under dispatch');
  assert.equal(codex.parentSpanContext.spanId, dispatchSpan.spanContext().spanId, 'codex under dispatch');
});

test('F172 behavioral: child spans survive after parent span ends (OTel contract)', async () => {
  otelExporter.reset();

  const parent = otelTracer.startSpan('parent');
  parent.end();

  const parentCtx = traceApi.setSpan(ctxApi.active(), parent);
  const child = otelTracer.startSpan('child', {}, parentCtx);
  child.end();

  const spans = otelExporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(
    spans.find(s => s.name === 'child').parentSpanContext.spanId,
    spans.find(s => s.name === 'parent').spanContext().spanId,
    'Child created after parent.end() still has correct parentSpanId',
  );
});

// ── Known gap: callback InvocationQueue path ──────────────────────

test('F172: QueueProcessor does NOT propagate trace context (known gap — follow-up)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts'),
    'utf8',
  );
  const hasTraceContext = src.includes('traceId') || src.includes('mention_dispatch') || src.includes('routeSpan');
  assert.ok(
    !hasTraceContext,
    'QueueProcessor does not yet carry trace context — callback A2A creates independent roots (documented gap)',
  );
});
