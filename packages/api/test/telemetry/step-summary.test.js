/**
 * F153 Phase I: Step Summary — AC-I1..AC-I7 coverage.
 *
 * - Behavioral: computeStepSummary on synthetic spans covers
 *   live/restored, missing marker, dual-track tool counts, width derivation,
 *   and the descriptive-only contract (no normative fields synthesized).
 * - Source-level: counter wiring (instruments + dispatch-span + route-serial),
 *   recordAgentLoop wiring (span-helpers + invoke-single-cat), Claude parser
 *   emits agent_loop on message_stop, AgentMessageType extension.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Source-level wiring (AC-I3, AC-I2, AC-I7) ──────────────────────

test('F153 Phase I: instruments.ts registers cat_cafe.a2a.dispatch.count counter', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/instruments.ts'), 'utf8');
  assert.ok(src.includes('a2aDispatchCount'), 'Should export a2aDispatchCount');
  assert.ok(src.includes('cat_cafe.a2a.dispatch.count'), 'Should register cat_cafe.a2a.dispatch.count instrument name');
});

test('F153 Phase I: dispatch-span.ts increments counter and accepts optional sourceCatId', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/dispatch-span.ts'), 'utf8');
  assert.ok(src.includes('a2aDispatchCount.add(1'), 'Should increment a2aDispatchCount');
  assert.ok(src.includes('sourceCatId'), 'wrapWithDispatchSpan should accept optional sourceCatId');
  assert.ok(
    !src.includes('invocationId'),
    'dispatch-span counter must NOT carry invocationId (metric-allowlist.ts forbids high-cardinality)',
  );
});

test('F153 Phase I: route-serial.ts increments a2aDispatchCount on in-process dispatch', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(src.includes('a2aDispatchCount'), 'Should import a2aDispatchCount');
  assert.ok(src.includes('a2aDispatchCount.add(1'), 'Should call a2aDispatchCount.add at dispatch span creation');
});

test('F153 Phase I: span-helpers.ts exports recordAgentLoop, sets agent_loop.count attribute', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/span-helpers.ts'), 'utf8');
  assert.ok(src.includes('export function recordAgentLoop'), 'Should export recordAgentLoop');
  assert.ok(src.includes("'agent_loop.count'"), 'Should set agent_loop.count attribute on invocationSpan');
  assert.ok(src.includes('agentLoopCounts'), 'Should use WeakMap counter (same pattern as toolCallCounts)');
});

test('F153 Phase I: Claude parser emits agent_loop AgentMessage at message_stop', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/providers/claude-ndjson-parser.ts'),
    'utf8',
  );
  assert.ok(src.includes("s.type === 'message_stop'"), 'Should detect message_stop event');
  assert.ok(
    src.includes("type: 'agent_loop' as const"),
    'Should return { type: agent_loop } AgentMessage (not null) at message_stop',
  );
});

test('F153 Phase I: AgentMessageType union extends with agent_loop', () => {
  const src = readFileSync(resolve(__dirname, '../../src/domains/cats/services/types.ts'), 'utf8');
  assert.ok(src.includes("'agent_loop'"), 'AgentMessageType should include agent_loop variant');
});

test('F153 Phase I: invoke-single-cat handles agent_loop telemetry-only (continue, no outputs)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(src.includes('recordAgentLoop'), 'Should import recordAgentLoop');
  assert.ok(
    src.includes("msg.type === 'agent_loop'") && src.includes('recordAgentLoop(invocationSpan)'),
    'Should branch on agent_loop and call recordAgentLoop',
  );
});

test('F153 Phase I: telemetry routes expose /api/telemetry/step-summary endpoint', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/telemetry.ts'), 'utf8');
  assert.ok(src.includes('/api/telemetry/step-summary'), 'Should register step-summary route');
  assert.ok(src.includes('computeStepSummary'), 'Should import computeStepSummary');
});

// ── Maine Coon review round 1 P1 fixes ─────────────────────────────

test('F153 Phase I (P1-1): callback-a2a-trigger lazy-creates dispatch span only when actually dispatching', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callback-a2a-trigger.ts'), 'utf8');
  // Lazy helper must exist
  assert.ok(src.includes('ensureDispatchTraceContext'), 'Should define ensureDispatchTraceContext lazy helper');
  // wrapWithDispatchSpan must NOT be called at function top before guards
  // (look for top-level early creation pattern)
  assert.ok(
    !/const dispatchTraceContext = opts\.callerTraceContext\s*\?\s*wrapWithDispatchSpan/.test(src),
    'Must NOT pre-allocate dispatchTraceContext before depth/dedup/streak guards',
  );
  // All three downstream usage points must go through the lazy helper
  assert.ok(src.includes('callerTraceContext: ensureDispatchTraceContext()'), 'enqueue path must use lazy helper');
});

test('F153 Phase I (P1-2): step-summary route reads full buffer, not capped at 500', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/telemetry.ts'), 'utf8');
  // Must NOT use a hard 500 cap
  assert.ok(
    !/traceStore\.query\(\{\s*traceId\s*,\s*limit:\s*500\s*\}\)/.test(src),
    'step-summary must not silently truncate long traces at 500 spans',
  );
  // Maine Coon round-2 non-blocking: prefer stats().maxSpans over a hardcoded constant so
  // tests / future configurations with non-default buffer capacity are honored.
  assert.ok(
    src.includes('traceStore.stats().maxSpans'),
    'step-summary should use traceStore.stats().maxSpans for query limit',
  );
});

test('F153 Phase I (round-2 P2): legacy worklist callback success also mints dispatch span/counter', () => {
  const src = readFileSync(resolve(__dirname, '../../src/routes/callback-a2a-trigger.ts'), 'utf8');
  // The lazy helper must be invoked in the worklist success branch (enqueued.length > 0)
  // — otherwise callbacks routed via the legacy F027 worklist path will silently skip the
  // mention_dispatch span and a2a.dispatch.count counter even when dispatch did happen.
  const worklistParts = src.split('if (hasWorklist(threadId))');
  assert.ok(worklistParts[1], 'callback-a2a-trigger should contain the legacy worklist branch');
  const successParts = worklistParts[1].split('if (enqueued.length > 0)');
  assert.ok(successParts[1], 'legacy worklist branch should contain the success branch');
  const successBranch = successParts[1];
  assert.ok(
    successBranch.includes('ensureDispatchTraceContext()'),
    'worklist success branch must call ensureDispatchTraceContext() (lazy side-effects: span + counter)',
  );
});

test('AC-I1 (P1-2 regression): computeStepSummary aggregates correctly across > 500 spans', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  // Synthesize a long trace: 1 route + many invocations with agent_loop.count, plus tool spans.
  const spans = [
    span({
      name: 'cat_cafe.route',
      spanId: 'r',
      durationMs: 50000,
      attributes: { 'route.total_tokens': 12345 },
    }),
  ];
  // 600 invocations, each contributing 1 to agent_loop_count
  for (let i = 0; i < 600; i++) {
    spans.push(
      span({
        name: 'cat_cafe.invocation',
        spanId: `i${i}`,
        parentSpanId: 'r',
        attributes: { 'agent_loop.count': 1, 'tool.basic_call_count': 0 },
      }),
    );
  }
  const summary = computeStepSummary(spans, 'trace-long');
  assert.equal(summary.agent_loop_count, 600, 'Should not silently truncate at 500');
  assert.equal(summary.tool_call_count, 0);
  assert.equal(summary.duration_ms, 50000);
});

// ── Behavioral: computeStepSummary (AC-I1, I2, I4, I5, I6) ─────────

const COMPUTE_PATH = '../../dist/infrastructure/telemetry/step-summary.js';

async function importComputeStepSummary() {
  try {
    return (await import(COMPUTE_PATH)).computeStepSummary;
  } catch {
    // Build not run yet — skip behavioral tests cleanly.
    return null;
  }
}

function span(overrides) {
  const base = {
    traceId: 't',
    spanId: 's',
    parentSpanId: undefined,
    name: 'cat_cafe.unknown',
    kind: 0,
    startTimeMs: 0,
    endTimeMs: 100,
    durationMs: 100,
    status: { code: 0 },
    attributes: {},
    events: [],
    storedAt: Date.now(),
  };
  return { ...base, ...overrides };
}

test('AC-I1+I6: computeStepSummary aggregates 6 metrics + Length × Width from live spans', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) {
    console.warn('  ↳ dist not built; behavioral suite skipped (source-level still validates wiring)');
    return;
  }

  const summary = computeStepSummary(
    [
      span({
        name: 'cat_cafe.route',
        spanId: 'r',
        durationMs: 1234,
        attributes: { 'route.total_tokens': 5678 },
      }),
      span({
        name: 'cat_cafe.invocation',
        spanId: 'i1',
        parentSpanId: 'r',
        attributes: { 'agent_loop.count': 3, 'tool.basic_call_count': 2 },
      }),
      span({
        name: 'cat_cafe.invocation',
        spanId: 'i2',
        parentSpanId: 'r',
        attributes: { 'agent_loop.count': 4, 'tool.basic_call_count': 1 },
      }),
      span({ name: 'cat_cafe.tool_use Read', spanId: 't1', parentSpanId: 'i1' }),
      span({ name: 'cat_cafe.tool_use Edit', spanId: 't2', parentSpanId: 'i1' }),
      span({ name: 'cat_cafe.mention_dispatch', spanId: 'd1', parentSpanId: 'i1' }),
    ],
    'trace-x',
  );
  assert.equal(summary.agent_loop_count, 7);
  assert.equal(summary.tool_call_count, 2 + 1 + 2); // basic + mcp
  assert.equal(summary.a2a_dispatch_count, 1);
  assert.equal(summary.duration_ms, 1234);
  assert.equal(summary.token_total, 5678);
  assert.equal(summary.is_restored, false);
  // Width = tool_call_count / agent_loop_count
  assert.ok(summary.width_avg_tools_per_loop != null);
  assert.ok(Math.abs(summary.width_avg_tools_per_loop - 5 / 7) < 1e-9);
});

test('AC-I4: restored-only trace returns null sub-counts (UI shows —, never 0)', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const summary = computeStepSummary(
    [
      span({ name: 'cat_cafe.invocation.restored', durationMs: 500 }),
      span({ name: 'cat_cafe.invocation.restored', durationMs: 700 }),
    ],
    'trace-restored',
  );
  assert.equal(summary.is_restored, true);
  assert.equal(summary.agent_loop_count, null);
  assert.equal(summary.tool_call_count, null);
  assert.equal(summary.a2a_dispatch_count, null);
  assert.equal(summary.width_avg_tools_per_loop, null);
});

test('AC-I2/I7 non-degradation: live invocations without agent_loop.count attr → agent_loop_count is null', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const summary = computeStepSummary(
    [
      span({ name: 'cat_cafe.route', spanId: 'r', durationMs: 200 }),
      span({ name: 'cat_cafe.invocation', spanId: 'i', parentSpanId: 'r', attributes: {} }),
    ],
    'trace-no-marker',
  );
  assert.equal(summary.is_restored, false);
  assert.equal(summary.agent_loop_count, null, 'No provider marker emitted → null, NOT 0');
  // Critical non-degradation: must not silently fall back to invocation count.
  assert.notEqual(summary.agent_loop_count, 1);
  assert.equal(summary.width_avg_tools_per_loop, null);
});

test('AC-I5: StepSummary never includes efficiency/quality/score fields (descriptive only, KD-32)', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const summary = computeStepSummary([span({ name: 'cat_cafe.route', durationMs: 1 })], 't');
  const keys = Object.keys(summary).map((k) => k.toLowerCase());
  for (const forbidden of ['efficiency', 'quality', 'score', 'rating', 'grade', 'goodness']) {
    assert.ok(!keys.some((k) => k.includes(forbidden)), `StepSummary must not include ${forbidden} field`);
  }
});

test('AC-I1: error_count counts only spans with ERROR status code', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const summary = computeStepSummary(
    [
      span({ name: 'cat_cafe.route', spanId: 'r', durationMs: 1 }),
      span({ name: 'cat_cafe.invocation', spanId: 'i', parentSpanId: 'r', status: { code: 2 } }),
      span({ name: 'cat_cafe.llm_call', spanId: 'l1', parentSpanId: 'i', status: { code: 2 } }),
      span({ name: 'cat_cafe.llm_call', spanId: 'l2', parentSpanId: 'i', status: { code: 0 } }),
    ],
    't',
  );
  assert.equal(summary.error_count, 2);
});

test('AC-I7: empty spans returns null (no synthetic data)', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  assert.equal(computeStepSummary([], 't'), null);
});

// ── Route vs trace scope (maintainer inbound review) ──────────────

test('Route scope: multi-route trace (real A2A shape) only counts spans within target route subtree', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  // Real A2A shape: route1 → invocation1 → mention_dispatch → route2 → invocation2
  // route2.parentSpanId = dispatch span (NOT route1) — mirrors actual OTel propagation.
  const spans = [
    span({
      name: 'cat_cafe.route',
      spanId: 'route1',
      startTimeMs: 0,
      endTimeMs: 5000,
      durationMs: 5000,
      attributes: { 'route.total_tokens': 1000 },
    }),
    span({
      name: 'cat_cafe.invocation',
      spanId: 'inv1',
      parentSpanId: 'route1',
      attributes: { 'agent_loop.count': 3, 'tool.basic_call_count': 1 },
    }),
    span({ name: 'cat_cafe.tool_use Read', spanId: 't1', parentSpanId: 'inv1' }),
    span({ name: 'cat_cafe.mention_dispatch', spanId: 'd1', parentSpanId: 'inv1' }),
    span({
      name: 'cat_cafe.route',
      spanId: 'route2',
      parentSpanId: 'd1',
      startTimeMs: 1000,
      endTimeMs: 3000,
      durationMs: 2000,
      attributes: { 'route.total_tokens': 500 },
    }),
    span({
      name: 'cat_cafe.invocation',
      spanId: 'inv2',
      parentSpanId: 'route2',
      attributes: { 'agent_loop.count': 2, 'tool.basic_call_count': 0 },
    }),
    span({ name: 'cat_cafe.tool_use Edit', spanId: 't2', parentSpanId: 'inv2' }),
  ];

  // Scope to route1: includes everything (route2 is a descendant via dispatch)
  const s1 = computeStepSummary(spans, 'trace-multi', 'route1');
  assert.equal(s1.routeSpanId, 'route1');
  assert.equal(s1.agent_loop_count, 5, 'route1 subtree: 3 + 2');
  assert.equal(s1.tool_call_count, 1 + 0 + 2, 'basic + MCP within full subtree');
  assert.equal(s1.a2a_dispatch_count, 1);
  assert.equal(s1.duration_ms, 5000);
  assert.equal(s1.token_total, 1000);

  // Scope to route2: only inv2 and its children
  const s2 = computeStepSummary(spans, 'trace-multi', 'route2');
  assert.equal(s2.routeSpanId, 'route2');
  assert.equal(s2.agent_loop_count, 2, 'route2 subtree only');
  assert.equal(s2.tool_call_count, 0 + 1, 'basic + MCP within route2');
  assert.equal(s2.a2a_dispatch_count, 0, 'mention_dispatch is under route1, not route2');
  assert.equal(s2.duration_ms, 2000);
  assert.equal(s2.token_total, 500);

  // Auto-detect (no routeSpanId): must pick route1, not route2, because route1 has
  // no parent in the trace while route2's parent (dispatch d1) is in the trace.
  const sAuto = computeStepSummary(spans, 'trace-multi');
  assert.equal(sAuto.routeSpanId, 'route1', 'Auto-detect must pick root route, not child');
  assert.equal(sAuto.agent_loop_count, 5);
});

test('Route scope: auto-detect picks root even when spans arrive newest-first', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  // Simulate LocalTraceStore newest-first order: child route appears before root.
  const spans = [
    span({
      name: 'cat_cafe.route',
      spanId: 'child-route',
      parentSpanId: 'dispatch1',
      startTimeMs: 2000,
      endTimeMs: 3000,
      durationMs: 1000,
      attributes: { 'route.total_tokens': 200 },
    }),
    span({ name: 'cat_cafe.mention_dispatch', spanId: 'dispatch1', parentSpanId: 'inv' }),
    span({
      name: 'cat_cafe.invocation',
      spanId: 'inv',
      parentSpanId: 'root-route',
      attributes: { 'agent_loop.count': 2 },
    }),
    span({
      name: 'cat_cafe.route',
      spanId: 'root-route',
      startTimeMs: 0,
      endTimeMs: 3000,
      durationMs: 3000,
      attributes: { 'route.total_tokens': 800 },
    }),
  ];

  const summary = computeStepSummary(spans, 'trace-auto');
  assert.equal(summary.routeSpanId, 'root-route', 'Must pick root even when child-route appears first in array');
  assert.equal(summary.duration_ms, 3000);
  assert.equal(summary.token_total, 800);
});

test('Mixed-provider: partial agent_loop.count coverage sets agent_loop_partial=true', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const spans = [
    span({
      name: 'cat_cafe.route',
      spanId: 'r',
      durationMs: 4000,
      attributes: { 'route.total_tokens': 600 },
    }),
    // Claude invocation — has agent_loop.count
    span({
      name: 'cat_cafe.invocation',
      spanId: 'claude-inv',
      parentSpanId: 'r',
      attributes: { 'agent_loop.count': 5, 'tool.basic_call_count': 2 },
    }),
    // Gemini invocation — no agent_loop.count (provider does not emit marker)
    span({
      name: 'cat_cafe.invocation',
      spanId: 'gemini-inv',
      parentSpanId: 'r',
      attributes: { 'tool.basic_call_count': 3 },
    }),
  ];

  const summary = computeStepSummary(spans, 'trace-mixed');
  assert.equal(summary.agent_loop_count, 5, 'Sum of available counts (lower bound)');
  assert.equal(summary.tool_call_count, 5, 'Tool counts can still be exact when loop coverage is partial');
  assert.equal(summary.agent_loop_partial, true, 'Should flag partial coverage');
  assert.equal(
    summary.width_avg_tools_per_loop,
    null,
    'Width must not render as precise when agent_loop_count is only a lower bound',
  );
});

test('Full coverage: agent_loop_partial is false when all invocations have the attribute', async () => {
  const computeStepSummary = await importComputeStepSummary();
  if (!computeStepSummary) return;

  const spans = [
    span({ name: 'cat_cafe.route', spanId: 'r', durationMs: 100 }),
    span({
      name: 'cat_cafe.invocation',
      spanId: 'i1',
      parentSpanId: 'r',
      attributes: { 'agent_loop.count': 3 },
    }),
    span({
      name: 'cat_cafe.invocation',
      spanId: 'i2',
      parentSpanId: 'r',
      attributes: { 'agent_loop.count': 2 },
    }),
  ];

  const summary = computeStepSummary(spans, 'trace-full');
  assert.equal(summary.agent_loop_count, 5);
  assert.equal(summary.agent_loop_partial, false);
});

// ── Frontend wiring (AC-I1, AC-I4) ─────────────────────────────────

test('F153 Phase I: HubTraceTree renders StepSummaryPanel with route scope', () => {
  const src = readFileSync(resolve(__dirname, '../../../web/src/components/HubTraceTree.tsx'), 'utf8');
  assert.ok(src.includes('StepSummaryPanel'), 'Should define StepSummaryPanel component');
  assert.ok(src.includes('/api/telemetry/step-summary'), 'Should fetch step-summary endpoint');
  assert.ok(src.includes("n === null ? '—'"), "Null sub-counts must render '—' (non-degradation, AC-I4)");
  assert.ok(src.includes('Restored (history)'), 'Should badge restored traces');
  assert.ok(src.includes('selectedRouteSpanId'), 'Should derive selected route span id from the trace tree selection');
  assert.ok(
    src.includes('routeSpanId={selectedRouteSpanId}'),
    'Should pass the selected route span id into StepSummaryPanel, not only define the prop',
  );
  assert.ok(
    src.includes("selectedSpanData?.name === 'cat_cafe.route'"),
    'Only selected cat_cafe.route spans should scope the Step Summary panel',
  );
  assert.ok(src.includes('setLoading(true);'), 'Route/trace changes should reset loading before refetching');
  assert.ok(src.includes('setData(null);'), 'Route/trace changes should clear stale summary data before refetching');
  assert.ok(src.includes('if (!res.ok)'), 'Non-OK step-summary responses must not keep stale metrics rendered');
  assert.ok(src.includes('agent_loop_partial'), 'Should handle partial coverage indicator');
});
