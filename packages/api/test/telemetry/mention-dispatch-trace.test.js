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

// ── P1: Route span aggregate attributes ──────────────────────────

test('F172 P1: genai-semconv exports route aggregate constants', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/infrastructure/telemetry/genai-semconv.ts'),
    'utf8',
  );
  assert.ok(src.includes("ROUTE_TOTAL_CATS_INVOKED = 'route.total_cats_invoked'"), 'Should export ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(src.includes("ROUTE_TOTAL_TOKENS = 'route.total_tokens'"), 'Should export ROUTE_TOTAL_TOKENS');
  assert.ok(src.includes("ROUTE_HAS_A2A_HANDOFF = 'route.has_a2a_handoff'"), 'Should export ROUTE_HAS_A2A_HANDOFF');
  assert.ok(src.includes("THREAD_ID = 'thread.id'"), 'Should export THREAD_ID');
});

test('F172 P1: route-serial sets aggregate attributes on routeSpan in finally', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(src.includes('ROUTE_TOTAL_CATS_INVOKED'), 'Should import ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(src.includes('ROUTE_TOTAL_TOKENS'), 'Should import ROUTE_TOTAL_TOKENS');
  assert.ok(src.includes('ROUTE_HAS_A2A_HANDOFF'), 'Should import ROUTE_HAS_A2A_HANDOFF');
  const finallyIdx = src.indexOf('} finally {');
  const setAttrIdx = src.indexOf('routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(
    finallyIdx > 0 && setAttrIdx > finallyIdx,
    'Aggregate attributes must be set inside finally block',
  );
});

test('F172 P1: route-serial accumulates routeTotalTokens from invocation_usage', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(src.includes('routeTotalTokens'), 'Should declare routeTotalTokens accumulator');
  assert.ok(
    src.includes("parsed.type === 'invocation_usage'") && src.includes('routeTotalTokens +='),
    'Should accumulate tokens from invocation_usage system_info messages',
  );
});

test('F172 P1: route-parallel sets aggregate attributes on routeSpan inside finally', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-parallel.ts'),
    'utf8',
  );
  assert.ok(src.includes('ROUTE_TOTAL_CATS_INVOKED'), 'Should import ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(src.includes('ROUTE_TOTAL_TOKENS'), 'Should import ROUTE_TOTAL_TOKENS');
  const finallyIdx = src.indexOf('} finally {');
  const setAttrIdx = src.indexOf('routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(
    finallyIdx > 0 && setAttrIdx > finallyIdx,
    'Aggregate attributes must be set inside finally block (abort/error safety)',
  );
  const tryIdx = src.indexOf('try {');
  const promiseAllIdx = src.indexOf('Promise.all(');
  assert.ok(
    tryIdx > 0 && tryIdx < promiseAllIdx,
    'try must start before Promise.all to cover pre-stream construction throws',
  );
});

// ── P1: Token metrics threadId dimension ─────────────────────────

test('F172 P1: metric-allowlist does NOT include THREAD_ID (high-cardinality guard)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/infrastructure/telemetry/metric-allowlist.ts'),
    'utf8',
  );
  assert.ok(!src.includes('THREAD_ID'), 'ALLOWED_METRIC_ATTRIBUTES must NOT include THREAD_ID — use route span aggregates for per-thread token queries');
});

test('F172 P1: tokenAttrs does NOT include THREAD_ID (cardinality + redactor bypass)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  const tokenAttrsMatch = src.match(/const tokenAttrs = \{[\s\S]*?\};/);
  assert.ok(tokenAttrsMatch, 'Should find tokenAttrs declaration');
  assert.ok(!tokenAttrsMatch[0].includes('THREAD_ID'), 'tokenAttrs must NOT include THREAD_ID');
});

// ── P1: HubTraceTree parallel rendering ──────────────────────────

test('F172 P1: HubTraceTree buildForest supports multiple children per parent (fan-out)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../../web/src/components/HubTraceTree.tsx'),
    'utf8',
  );
  assert.ok(
    src.includes('childMap') && src.includes('children'),
    'buildForest should accumulate children per parent via childMap',
  );
});

// ── Cross-route A2A trace propagation ─────────────────────────────

test('F172: InvocationRecord declares traceContext field with traceFlags', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('traceContext?: { traceId: string; spanId: string; traceFlags: number }'),
    'InvocationRecord should declare traceContext field with traceFlags',
  );
  assert.ok(src.includes('setTraceContext'), 'Registry should have setTraceContext method');
});

test('F172: invoke-single-cat stores traceContext in InvocationRecord after span creation', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('registry.setTraceContext(invocationId'),
    'Should call registry.setTraceContext after invocationSpan creation',
  );
});

test('F172: AgentRouter.routeExecution accepts callerTraceContext and creates child span', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/AgentRouter.ts'),
    'utf8',
  );
  assert.ok(src.includes('callerTraceContext'), 'routeExecution options should accept callerTraceContext');
  assert.ok(
    src.includes('trace.setSpanContext') && src.includes('isRemote: true'),
    'Should reconstruct remote parent span context from callerTraceContext',
  );
  assert.ok(
    src.includes('callerTraceContext.traceFlags'),
    'Should use stored traceFlags, not hardcoded TraceFlags.SAMPLED',
  );
  assert.ok(
    !src.includes('TraceFlags.SAMPLED'),
    'Must not hardcode TraceFlags.SAMPLED — use stored value',
  );
});

test('F172: callbacks.ts passes traceContext from InvocationRecord to enqueueA2ATargets', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callbacks.ts'), 'utf8');
  assert.ok(
    src.includes('callerTraceContext: record.traceContext'),
    'Should pass record.traceContext as callerTraceContext',
  );
});

test('F172: callback-a2a-trigger propagates callerTraceContext to both queue and legacy paths', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callback-a2a-trigger.ts'), 'utf8');
  assert.ok(
    src.includes('callerTraceContext: opts.callerTraceContext'),
    'Should pass callerTraceContext to invocationQueue.enqueue',
  );
  const triggerIdx = src.indexOf('async function triggerA2AInvocation');
  const routeExecIdx = src.indexOf('callerTraceContext: opts.callerTraceContext', triggerIdx);
  assert.ok(
    triggerIdx > 0 && routeExecIdx > triggerIdx,
    'triggerA2AInvocation should pass callerTraceContext to routeExecution',
  );
});

test('F172: InvocationQueue entry includes callerTraceContext field', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts'),
    'utf8',
  );
  assert.ok(
    src.includes("callerTraceContext?: { traceId: string; spanId: string; traceFlags: number }"),
    'QueueEntry should declare callerTraceContext field with traceFlags',
  );
});

test('F172: InvocationQueue prevents merge of agent entries with different callerTraceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('traceContextMismatch') && src.includes('callerTraceContext?.spanId'),
    'Should detect traceContext mismatch on agent entry merge',
  );
  assert.ok(
    src.includes('!traceContextMismatch'),
    'Merge condition should check !traceContextMismatch',
  );
});

test('F172: start_vote callback passes callerTraceContext to enqueueA2ATargets', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callbacks.ts'), 'utf8');
  const voteIdx = src.indexOf('start-vote');
  const a2aOptsIdx = src.indexOf('callerTraceContext: record.traceContext', voteIdx);
  assert.ok(
    voteIdx > 0 && a2aOptsIdx > voteIdx,
    'start_vote callback should pass record.traceContext as callerTraceContext',
  );
});

test('F172: invoke-single-cat stores traceFlags in traceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('traceFlags: sc.traceFlags'),
    'Should persist traceFlags from spanContext',
  );
});

test('F172: QueueProcessor passes callerTraceContext from entry to routeExecution', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('entry.callerTraceContext'),
    'QueueProcessor should pass entry.callerTraceContext to routeExecution',
  );
});

// ── Behavioral: cross-route span parenting via remote context ────

test('F172 behavioral: remote parent context links child route span to caller trace', async () => {
  otelExporter.reset();

  // Simulate: route1 → invocation(A) → [callback post_message] → route2(child of A)
  const route1Span = otelTracer.startSpan('cat_cafe.route');
  const route1Ctx = traceApi.setSpan(ctxApi.active(), route1Span);

  const invA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, route1Ctx);

  // Capture trace context (simulating what invoke-single-cat stores in InvocationRecord)
  const callerCtx = invA.spanContext();
  invA.end();
  route1Span.end();

  // Reconstruct remote parent (simulating what AgentRouter.routeExecution does)
  const { context: ctxApiLocal, trace: traceApiLocal, TraceFlags: TF } = await import('@opentelemetry/api');
  const remoteParentCtx = traceApiLocal.setSpanContext(ctxApiLocal.active(), {
    traceId: callerCtx.traceId,
    spanId: callerCtx.spanId,
    traceFlags: TF.SAMPLED,
    isRemote: true,
  });
  const route2Span = otelTracer.startSpan('cat_cafe.route', {}, remoteParentCtx);
  const route2Ctx = traceApiLocal.setSpan(ctxApiLocal.active(), route2Span);
  const invB = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'sonnet' } }, route2Ctx);
  invB.end();
  route2Span.end();

  const spans = otelExporter.getFinishedSpans();
  assert.equal(spans.length, 4);

  const route1 = spans.find(s => s.name === 'cat_cafe.route' && !s.parentSpanContext);
  const invASpan = spans.find(s => s.attributes['agent.id'] === 'opus');
  const route2 = spans.find(s => s.name === 'cat_cafe.route' && s.parentSpanContext);
  const invBSpan = spans.find(s => s.attributes['agent.id'] === 'sonnet');

  assert.ok(route1 && invASpan && route2 && invBSpan, 'All 4 spans should be present');

  // Same traceId across both routes
  const traceId = route1.spanContext().traceId;
  assert.equal(route2.spanContext().traceId, traceId, 'route2 shares same traceId as route1');
  assert.equal(invBSpan.spanContext().traceId, traceId, 'invocation B shares same traceId');

  // route2 is child of invocation A (cross-route link)
  assert.equal(
    route2.parentSpanContext.spanId, invASpan.spanContext().spanId,
    'route2 is child of invocation A (cross-route A2A trace link)',
  );
  // invocation B is child of route2
  assert.equal(
    invBSpan.parentSpanContext.spanId, route2.spanContext().spanId,
    'invocation B is child of route2',
  );
});
