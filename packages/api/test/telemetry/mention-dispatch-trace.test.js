/**
 * F153: Cross-cat trace propagation via mention_dispatch spans.
 *
 * Covers:
 * - Text-scan A2A path: mention_dispatch span created as child of mentioner's invocation
 * - Callback A2A path: wrapWithDispatchSpan inserts mention_dispatch between caller and dispatched route
 * - invocationSpanRef: caller can capture invocation span reference
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── invocationSpanRef param exists on InvocationParams ─────────────

test('F153: InvocationParams declares invocationSpanRef field', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('invocationSpanRef') && src.includes('{ current?:'),
    'InvocationParams should declare invocationSpanRef with { current?: Span } shape',
  );
});

test('F153: invokeSingleCat writes span to invocationSpanRef', () => {
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

test('F153: route-serial creates cat_cafe.mention_dispatch span on A2A push', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes("'cat_cafe.mention_dispatch'") && src.includes('dispatch.target_count'),
    'Should create mention_dispatch span with dispatch.target_count attribute',
  );
});

test('F153: route-serial tracks mentionParentSpan for dispatched targets', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('mentionParentSpan') && src.includes('catInvocationSpans'),
    'Should track both mentionParentSpan and catInvocationSpans maps',
  );
});

test('F153: route-serial tracks catInvocationSpans per worklist index', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('catInvocationSpans.set(index, invocationSpanRef.current)'),
    'Should store invocation span by worklist index after cat completes',
  );
});

test('F153: dispatched cat uses mentionParentSpan as effective routeSpan', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('mentionParentSpan.get(index)') && src.includes('routeSpan: mentionParentSpan.get(index)'),
    'Should use mention dispatch span as parent for A2A-dispatched cat invocations',
  );
});

// ── Dispatch span deferred end ────────────────────────────────────

test('F153: dispatch span end is deferred until last child completes', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('pendingDispatchSpans') && src.includes('lastChildIndex'),
    'Should track pending dispatch spans with lastChildIndex for deferred end',
  );
});

// ── Dispatch span lifecycle ────────────────────────────────────────

test('F153: dispatch spans ended unconditionally in finally block', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('pendingDispatchSpans') && src.includes('entry.span.end()'),
    'Should end all dispatch spans unconditionally in finally block',
  );
});

test('F153: finally block ends orphaned dispatch spans on early abort', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  const finallyIdx = src.indexOf('} finally {');
  const cleanupIdx = src.indexOf('entry.span.end()');
  assert.ok(
    finallyIdx > 0 && cleanupIdx > finallyIdx,
    'Finally block should unconditionally end all pending dispatch spans (abort safety)',
  );
});

// ── Behavioral: OTel span parent-child wiring (real tracer) ───────

const { context: ctxApi, trace: traceApi } = await import('@opentelemetry/api');
const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const otelExporter = new InMemorySpanExporter();
const otelProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
});
otelProvider.register();
const otelTracer = otelProvider.getTracer('test-mention-dispatch');

test('F153 behavioral: mention_dispatch span is child of mentioner invocation', async () => {
  otelExporter.reset();

  // Simulate: route → invocation(A) → mention_dispatch → invocation(B)
  const routeSpan = otelTracer.startSpan('cat_cafe.route');
  const routeCtx = traceApi.setSpan(ctxApi.active(), routeSpan);

  const invocationA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, routeCtx);
  invocationA.end();

  // mention_dispatch as child of invocation A (even though A already ended)
  const invACtx = traceApi.setSpan(ctxApi.active(), invocationA);
  const dispatchSpan = otelTracer.startSpan(
    'cat_cafe.mention_dispatch',
    {
      attributes: { 'mention.targets': 'sonnet,codex' },
    },
    invACtx,
  );

  // invocation B as child of mention_dispatch
  const dispatchCtx = traceApi.setSpan(ctxApi.active(), dispatchSpan);
  const invocationB = otelTracer.startSpan(
    'cat_cafe.invocation',
    { attributes: { 'agent.id': 'sonnet' } },
    dispatchCtx,
  );
  invocationB.end();

  dispatchSpan.end();
  routeSpan.end();

  // Verify hierarchy via exported spans
  const spans = otelExporter.getFinishedSpans();
  assert.equal(spans.length, 4);

  const route = spans.find((s) => s.name === 'cat_cafe.route');
  const invA = spans.find((s) => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === 'opus');
  const dispatch = spans.find((s) => s.name === 'cat_cafe.mention_dispatch');
  const invB = spans.find((s) => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === 'sonnet');

  assert.ok(route && invA && dispatch && invB, 'All 4 spans should be present');

  // Same trace
  const traceId = route.spanContext().traceId;
  assert.equal(invA.spanContext().traceId, traceId, 'invocation A same trace');
  assert.equal(dispatch.spanContext().traceId, traceId, 'dispatch same trace');
  assert.equal(invB.spanContext().traceId, traceId, 'invocation B same trace');

  // Parent-child: route → invA → dispatch → invB
  assert.equal(invA.parentSpanContext.spanId, route.spanContext().spanId, 'invocation A is child of route');
  assert.equal(
    dispatch.parentSpanContext.spanId,
    invA.spanContext().spanId,
    'mention_dispatch is child of invocation A',
  );
  assert.equal(
    invB.parentSpanContext.spanId,
    dispatch.spanContext().spanId,
    'invocation B is child of mention_dispatch',
  );
});

test('F153 behavioral: multiple mentioned cats share same dispatch parent', async () => {
  otelExporter.reset();

  const routeSpan = otelTracer.startSpan('cat_cafe.route');
  const routeCtx = traceApi.setSpan(ctxApi.active(), routeSpan);

  const invA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, routeCtx);
  invA.end();

  const invACtx = traceApi.setSpan(ctxApi.active(), invA);
  const dispatch = otelTracer.startSpan(
    'cat_cafe.mention_dispatch',
    {
      attributes: { 'mention.targets': 'sonnet,codex' },
    },
    invACtx,
  );
  const dispatchCtx = traceApi.setSpan(ctxApi.active(), dispatch);

  const invB = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'sonnet' } }, dispatchCtx);
  invB.end();
  const invC = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'codex' } }, dispatchCtx);
  invC.end();

  dispatch.end();
  routeSpan.end();

  const spans = otelExporter.getFinishedSpans();
  const dispatchSpan = spans.find((s) => s.name === 'cat_cafe.mention_dispatch');
  const sonnet = spans.find((s) => s.attributes['agent.id'] === 'sonnet');
  const codex = spans.find((s) => s.attributes['agent.id'] === 'codex');

  assert.equal(sonnet.parentSpanContext.spanId, dispatchSpan.spanContext().spanId, 'sonnet under dispatch');
  assert.equal(codex.parentSpanContext.spanId, dispatchSpan.spanContext().spanId, 'codex under dispatch');
});

test('F153 behavioral: child spans survive after parent span ends (OTel contract)', async () => {
  otelExporter.reset();

  const parent = otelTracer.startSpan('parent');
  parent.end();

  const parentCtx = traceApi.setSpan(ctxApi.active(), parent);
  const child = otelTracer.startSpan('child', {}, parentCtx);
  child.end();

  const spans = otelExporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(
    spans.find((s) => s.name === 'child').parentSpanContext.spanId,
    spans.find((s) => s.name === 'parent').spanContext().spanId,
    'Child created after parent.end() still has correct parentSpanId',
  );
});

// ── P1: Route span aggregate attributes ──────────────────────────

test('F153 P1: genai-semconv exports route aggregate constants', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/genai-semconv.ts'), 'utf8');
  assert.ok(
    src.includes("ROUTE_TOTAL_CATS_INVOKED = 'route.total_cats_invoked'"),
    'Should export ROUTE_TOTAL_CATS_INVOKED',
  );
  assert.ok(src.includes("ROUTE_TOTAL_TOKENS = 'route.total_tokens'"), 'Should export ROUTE_TOTAL_TOKENS');
  assert.ok(src.includes("ROUTE_HAS_A2A_HANDOFF = 'route.has_a2a_handoff'"), 'Should export ROUTE_HAS_A2A_HANDOFF');
});

test('F153 P1: route-serial sets aggregate attributes on routeSpan in finally', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(src.includes('ROUTE_TOTAL_CATS_INVOKED'), 'Should import ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(src.includes('ROUTE_TOTAL_TOKENS'), 'Should import ROUTE_TOTAL_TOKENS');
  assert.ok(src.includes('ROUTE_HAS_A2A_HANDOFF'), 'Should import ROUTE_HAS_A2A_HANDOFF');
  const finallyIdx = src.indexOf('} finally {');
  const setAttrIdx = src.indexOf('routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(finallyIdx > 0 && setAttrIdx > finallyIdx, 'Aggregate attributes must be set inside finally block');
});

test('F153 P1: route-serial accumulates routeTotalTokens from invocation_usage', () => {
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

test('F153 P1: route-parallel sets aggregate attributes on routeSpan', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-parallel.ts'),
    'utf8',
  );
  assert.ok(src.includes('ROUTE_TOTAL_CATS_INVOKED'), 'Should import ROUTE_TOTAL_CATS_INVOKED');
  assert.ok(src.includes('ROUTE_TOTAL_TOKENS'), 'Should import ROUTE_TOTAL_TOKENS');
  assert.ok(
    src.includes('routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED'),
    'Should set ROUTE_TOTAL_CATS_INVOKED on routeSpan',
  );
});

// ── P1: Token metrics threadId dimension ─────────────────────────

test('F153 P1: metric-allowlist does NOT include THREAD_ID (high-cardinality guard)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/metric-allowlist.ts'), 'utf8');
  assert.ok(
    !src.includes('THREAD_ID'),
    'ALLOWED_METRIC_ATTRIBUTES must NOT include THREAD_ID — use route span aggregates for per-thread token queries',
  );
});

test('F153 P1: tokenAttrs does NOT include THREAD_ID (cardinality + redactor bypass)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  const tokenAttrsMatch = src.match(/const tokenAttrs = \{[\s\S]*?\};/);
  assert.ok(tokenAttrsMatch, 'Should find tokenAttrs declaration');
  assert.ok(!tokenAttrsMatch[0].includes('THREAD_ID'), 'tokenAttrs must NOT include THREAD_ID');
});

// ── P1: HubTraceTree parallel rendering ──────────────────────────

test('F153 P1: HubTraceTree buildForest supports multiple children per parent (fan-out)', () => {
  const src = readFileSync(resolve(__dirname, '../../../web/src/components/trace-tree-utils.ts'), 'utf8');
  assert.ok(
    src.includes('childMap') && src.includes('children'),
    'buildForest should accumulate children per parent via childMap',
  );
});

// ── Cross-route A2A trace propagation ─────────────────────────────

test('F153: InvocationRecord declares traceContext field with CallerTraceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('traceContext?: CallerTraceContext'),
    'InvocationRecord should declare traceContext field with CallerTraceContext type',
  );
  assert.ok(src.includes('setTraceContext'), 'Registry should have setTraceContext method');
});

test('F153: invoke-single-cat stores traceContext in InvocationRecord after span creation', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('registry.setTraceContext(invocationId'),
    'Should call registry.setTraceContext after invocationSpan creation',
  );
});

test('F153: AgentRouter.routeExecution accepts callerTraceContext and creates child span', () => {
  const src = readFileSync(resolve(__dirname, '../../src/domains/cats/services/agents/routing/AgentRouter.ts'), 'utf8');
  assert.ok(src.includes('callerTraceContext'), 'routeExecution options should accept callerTraceContext');
  assert.ok(
    src.includes('trace.setSpanContext') && src.includes('isRemote: true'),
    'Should reconstruct remote parent span context from callerTraceContext',
  );
  assert.ok(
    src.includes('callerTraceContext.traceFlags'),
    'Should use stored traceFlags, not hardcoded TraceFlags.SAMPLED',
  );
  assert.ok(!src.includes('TraceFlags.SAMPLED'), 'Must not hardcode TraceFlags.SAMPLED — use stored value');
});

test('F153: callbacks.ts passes traceContext from InvocationRecord to enqueueA2ATargets', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callbacks.ts'), 'utf8');
  assert.ok(
    src.includes('callerTraceContext: record.traceContext'),
    'Should pass record.traceContext as callerTraceContext',
  );
});

test('F153: callback-a2a-trigger propagates callerTraceContext to both queue and legacy paths', () => {
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

test('F153: InvocationQueue entry includes callerTraceContext field', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('callerTraceContext?: CallerTraceContext'),
    'QueueEntry should declare callerTraceContext field with CallerTraceContext type',
  );
});

test('F153: InvocationQueue entry construction includes callerTraceContext from input', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('callerTraceContext: input.callerTraceContext'),
    'Entry construction should copy callerTraceContext from input',
  );
});

test('F153: start_vote callback passes callerTraceContext to enqueueA2ATargets', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callbacks.ts'), 'utf8');
  const voteIdx = src.indexOf('start-vote');
  const a2aOptsIdx = src.indexOf('callerTraceContext: record.traceContext', voteIdx);
  assert.ok(
    voteIdx > 0 && a2aOptsIdx > voteIdx,
    'start_vote callback should pass record.traceContext as callerTraceContext',
  );
});

test('F153: invoke-single-cat stores traceFlags in traceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(src.includes('traceFlags: sc.traceFlags'), 'Should persist traceFlags from spanContext');
});

test('F153: QueueProcessor passes callerTraceContext from entry to routeExecution', () => {
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

test('F153 behavioral: remote parent context links child route span to caller trace', async () => {
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

  const route1 = spans.find((s) => s.name === 'cat_cafe.route' && !s.parentSpanContext);
  const invASpan = spans.find((s) => s.attributes['agent.id'] === 'opus');
  const route2 = spans.find((s) => s.name === 'cat_cafe.route' && s.parentSpanContext);
  const invBSpan = spans.find((s) => s.attributes['agent.id'] === 'sonnet');

  assert.ok(route1 && invASpan && route2 && invBSpan, 'All 4 spans should be present');

  // Same traceId across both routes
  const traceId = route1.spanContext().traceId;
  assert.equal(route2.spanContext().traceId, traceId, 'route2 shares same traceId as route1');
  assert.equal(invBSpan.spanContext().traceId, traceId, 'invocation B shares same traceId');

  // route2 is child of invocation A (cross-route link)
  assert.equal(
    route2.parentSpanContext.spanId,
    invASpan.spanContext().spanId,
    'route2 is child of invocation A (cross-route A2A trace link)',
  );
  // invocation B is child of route2
  assert.equal(invBSpan.parentSpanContext.spanId, route2.spanContext().spanId, 'invocation B is child of route2');
});

// ── Callback A2A: mention_dispatch span via wrapWithDispatchSpan ──

test('F153: callback-a2a-trigger imports and uses wrapWithDispatchSpan', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callback-a2a-trigger.ts'), 'utf8');
  assert.ok(src.includes('wrapWithDispatchSpan'), 'Should import wrapWithDispatchSpan');
  assert.ok(src.includes('dispatchTraceContext'), 'Should compute dispatchTraceContext from caller context');
});

test('F153 behavioral: wrapWithDispatchSpan creates mention_dispatch as child of caller', async () => {
  otelExporter.reset();

  const callerSpan = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } });
  const callerSc = callerSpan.spanContext();
  callerSpan.end();

  const { wrapWithDispatchSpan } = await import('../../dist/infrastructure/telemetry/dispatch-span.js');
  const dispatchCtx = wrapWithDispatchSpan(
    { traceId: callerSc.traceId, spanId: callerSc.spanId, traceFlags: callerSc.traceFlags },
    2,
  );

  assert.equal(dispatchCtx.traceId, callerSc.traceId, 'dispatch span shares caller traceId');
  assert.notEqual(dispatchCtx.spanId, callerSc.spanId, 'dispatch span has its own spanId');

  const spans = otelExporter.getFinishedSpans();
  const dispatch = spans.find((s) => s.name === 'cat_cafe.mention_dispatch');
  assert.ok(dispatch, 'mention_dispatch span should be created');
  assert.equal(dispatch.attributes['dispatch.target_count'], 2, 'Should record target count');
  assert.equal(dispatch.attributes['dispatch.source'], 'callback', 'Should mark source as callback');
  assert.equal(dispatch.parentSpanContext.spanId, callerSc.spanId, 'dispatch is child of caller');
});

// ── F185 deferred A2A path: mention_dispatch span + counter + ctx ──

test('F153 Phase I (F185 deferred): route-serial creates mention_dispatch span in deferred path', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  // The deferred branch is the `else if (... && deferA2AEnqueue && !catSignal?.aborted)` block.
  const deferredIdx = src.indexOf('deferA2AEnqueue && !catSignal?.aborted');
  assert.ok(deferredIdx > 0, 'Should find the deferred branch guard');
  // After the deferred guard, the same block should create a mention_dispatch span tagged as deferred.
  const dispatchSpanIdx = src.indexOf("'cat_cafe.mention_dispatch'", deferredIdx);
  const deferredSourceIdx = src.indexOf("'dispatch.source': 'text-scan-deferred'", deferredIdx);
  assert.ok(dispatchSpanIdx > deferredIdx, 'Deferred branch should create cat_cafe.mention_dispatch span');
  assert.ok(
    deferredSourceIdx > deferredIdx,
    "Deferred dispatch span should set dispatch.source='text-scan-deferred' (distinct from callback/inline)",
  );
});

test('F153 Phase I (F185 deferred): deferred path increments a2aDispatchCount', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  const deferredIdx = src.indexOf('deferA2AEnqueue && !catSignal?.aborted');
  const counterIdx = src.indexOf('a2aDispatchCount.add', deferredIdx);
  assert.ok(
    counterIdx > deferredIdx,
    'Deferred branch should call a2aDispatchCount.add — otherwise Step Summary aggregate under-reports',
  );
});

test('F153 Phase I (F185 deferred): deferA2AEnqueue entry carries callerTraceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  const deferredIdx = src.indexOf('deferA2AEnqueue && !catSignal?.aborted');
  // After the deferred guard, the enqueue invocation should include callerTraceContext
  // so QueueProcessor reuses it as the parent for the dispatched route.
  const enqueueCallIdx = src.indexOf('deferA2AEnqueue({', deferredIdx);
  const ctxFieldIdx = src.indexOf('callerTraceContext: deferredDispatchCtx', deferredIdx);
  assert.ok(enqueueCallIdx > deferredIdx, 'Deferred branch should call deferA2AEnqueue({...})');
  assert.ok(
    ctxFieldIdx > enqueueCallIdx,
    'deferA2AEnqueue entry must include callerTraceContext: deferredDispatchCtx — otherwise cross-route causality is severed at the fairness gate',
  );
});

test('F153 Phase I (F185 deferred): deferA2AEnqueue entry contract declares callerTraceContext', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-helpers.ts'),
    'utf8',
  );
  // The entry type for deferA2AEnqueue must declare callerTraceContext so callers (route-serial,
  // and downstream consumers including QueueProcessor) see a stable contract.
  assert.ok(
    src.includes('callerTraceContext?: import(') && src.includes('CallerTraceContext'),
    'RouteOptions.deferA2AEnqueue entry type should declare optional callerTraceContext field',
  );
});

test('F153 Phase I behavioral (F185 deferred): captured ctx parents the dispatched route', async () => {
  otelExporter.reset();

  // Simulate route-serial deferred path:
  // route1 → invocation(A) → mention_dispatch (ended immediately, source=text-scan-deferred)
  //                                           ↘ queue handoff (captured ctx)
  // Later: QueueProcessor → route2 (child of mention_dispatch via remote ctx)
  const route1 = otelTracer.startSpan('cat_cafe.route');
  const route1Ctx = traceApi.setSpan(ctxApi.active(), route1);

  const invA = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'opus' } }, route1Ctx);

  // Lazy create dispatch span as child of mentioner invocation, then immediately end.
  const invACtx = traceApi.setSpan(ctxApi.active(), invA);
  const dispatchSpan = otelTracer.startSpan(
    'cat_cafe.mention_dispatch',
    {
      attributes: {
        'agent.id': 'opus',
        'dispatch.target_count': 1,
        'dispatch.source': 'text-scan-deferred',
      },
    },
    invACtx,
  );
  const dispatchSc = dispatchSpan.spanContext();
  dispatchSpan.end();
  invA.end();
  route1.end();

  // Captured CallerTraceContext propagated through queue entry.
  const callerCtx = { traceId: dispatchSc.traceId, spanId: dispatchSc.spanId, traceFlags: dispatchSc.traceFlags };

  // Downstream QueueProcessor reconstructs remote parent (mirrors AgentRouter.routeExecution).
  const { context: ctxApiLocal, trace: traceApiLocal } = await import('@opentelemetry/api');
  const remoteParentCtx = traceApiLocal.setSpanContext(ctxApiLocal.active(), {
    traceId: callerCtx.traceId,
    spanId: callerCtx.spanId,
    traceFlags: callerCtx.traceFlags,
    isRemote: true,
  });
  const route2 = otelTracer.startSpan('cat_cafe.route', {}, remoteParentCtx);
  const route2Ctx = traceApiLocal.setSpan(ctxApiLocal.active(), route2);
  const invB = otelTracer.startSpan('cat_cafe.invocation', { attributes: { 'agent.id': 'sonnet' } }, route2Ctx);
  invB.end();
  route2.end();

  const spans = otelExporter.getFinishedSpans();
  const dispatch = spans.find(
    (s) => s.name === 'cat_cafe.mention_dispatch' && s.attributes['dispatch.source'] === 'text-scan-deferred',
  );
  const route2Span = spans.find((s) => s.name === 'cat_cafe.route' && s.parentSpanContext);
  const invBSpan = spans.find((s) => s.attributes['agent.id'] === 'sonnet');

  assert.ok(dispatch, 'deferred dispatch span should be present');
  assert.ok(route2Span && invBSpan, 'queued route2 and invocation B should be present');

  // Same trace across the fairness-gate hop.
  const traceId = dispatch.spanContext().traceId;
  assert.equal(route2Span.spanContext().traceId, traceId, 'queued route stays in caller trace');
  assert.equal(invBSpan.spanContext().traceId, traceId, 'dispatched invocation stays in caller trace');

  // route2 is parented at the dispatch span (not the mentioner directly).
  assert.equal(
    route2Span.parentSpanContext.spanId,
    dispatch.spanContext().spanId,
    'queued route is child of mention_dispatch (preserves causality through fairness gate)',
  );
});
