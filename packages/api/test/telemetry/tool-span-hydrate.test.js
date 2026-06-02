/**
 * F153 Phase J Slice J-B AC-J7 + AC-J8 behavioral tests.
 *
 * AC-J7: StoredToolEvent schema extension is validated indirectly by AC-J8 —
 *        we feed StoredToolEvent[] (with the new optional fields populated)
 *        into the hydrate synthesis function and assert the resulting spans
 *        have the right shape.
 *
 * AC-J8: hydrate-side `synthesizeToolSpansFromEvents` must pair tool_use ↔
 *        tool_result events by toolUseId and emit one real-duration
 *        `cat_cafe.tool_use {toolName}` TraceSpanDTO per pair, with status
 *        mapped to OTel SpanStatusCode (ok=1, error=2, unknown/missing=0).
 *
 * KD-41 honesty: events without the four-piece set (toolUseId / tracing /
 * status / start+end timestamps) are silently skipped — no fake spans, no
 * degraded `invocation.restored` markers.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { synthesizeToolSpansFromEvents } = await import('../../dist/infrastructure/telemetry/hydrate-traces.js');

const tracing = (traceId, spanId, parentSpanId) => ({ traceId, spanId, parentSpanId });

test('F153 Phase J AC-J8: pairs tool_use + tool_result by toolUseId, computes real duration', () => {
  const events = [
    {
      id: 'tool-1',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'use-1',
      tracing: tracing('t-aaa', 's-bbb', 'p-inv-1'),
      startTimeMs: 1_000_000,
      timestamp: 1_000_000,
    },
    {
      id: 'toolr-1',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-1',
      status: 'ok',
      tracing: tracing('t-aaa', 's-bbb', 'p-inv-1'),
      endTimeMs: 1_000_230,
      timestamp: 1_000_230,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'opus', 1_000_500);
  assert.equal(dto.name, 'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_post_message');
  assert.equal(dto.traceId, 't-aaa');
  assert.equal(dto.spanId, 's-bbb');
  assert.equal(dto.parentSpanId, 'p-inv-1');
  assert.equal(dto.startTimeMs, 1_000_000);
  assert.equal(dto.endTimeMs, 1_000_230);
  assert.equal(dto.durationMs, 230, 'real duration (not zero)');
  assert.equal(dto.status.code, 1, 'OTel OK = 1');
  assert.equal(dto.attributes['tool.use_id'], 'use-1');
  assert.equal(dto.attributes['agent.id'], 'opus');
  assert.equal(dto.attributes['tool.result.status'], 'ok');
});

test('F153 Phase J AC-J8: error status maps to OTel SpanStatusCode.ERROR (=2)', () => {
  const events = [
    {
      id: 'tool-2',
      type: 'tool_use',
      label: 'codex → mcp:cat-cafe/post_message',
      toolUseId: 'use-err',
      tracing: tracing('t-2', 's-2'),
      startTimeMs: 2_000,
      timestamp: 2_000,
    },
    {
      id: 'toolr-2',
      type: 'tool_result',
      label: 'codex ← result',
      toolUseId: 'use-err',
      status: 'error',
      tracing: tracing('t-2', 's-2'),
      endTimeMs: 2_150,
      timestamp: 2_150,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'codex', 3_000);
  assert.equal(dto.status.code, 2, 'OTel ERROR = 2');
  assert.equal(dto.attributes['tool.result.status'], 'error');
});

test('F153 Phase J AC-J8: unknown status maps to UNSET (=0) — KD-38 honesty, no fake OK', () => {
  const events = [
    {
      id: 'tool-3',
      type: 'tool_use',
      label: 'sonnet → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'use-?',
      tracing: tracing('t-3', 's-3'),
      startTimeMs: 100,
      timestamp: 100,
    },
    {
      id: 'toolr-3',
      type: 'tool_result',
      label: 'sonnet ← result',
      toolUseId: 'use-?',
      status: 'unknown',
      tracing: tracing('t-3', 's-3'),
      endTimeMs: 200,
      timestamp: 200,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'sonnet', 500);
  assert.equal(dto.status.code, 0, 'OTel UNSET (=0) for unknown status');
});

test('F153 Phase J AC-J8 (KD-41 honesty): events missing toolUseId are skipped', () => {
  const events = [
    {
      id: 'tool-legacy',
      type: 'tool_use',
      label: 'gemini → some_tool',
      timestamp: 100,
      // no toolUseId, no tracing → legacy provider, must be skipped
    },
    {
      id: 'toolr-legacy',
      type: 'tool_result',
      label: 'gemini ← result',
      timestamp: 200,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'gemini', 500);
  assert.equal(dtos.length, 0, 'no fake spans for legacy/unwired events (KD-41)');
});

test('F153 Phase J AC-J8: tool_result without matching tool_use is silently skipped', () => {
  const events = [
    {
      id: 'toolr-orphan',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-orphan',
      status: 'ok',
      tracing: tracing('t-o', 's-o'),
      endTimeMs: 5_000,
      timestamp: 5_000,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 6_000);
  assert.equal(dtos.length, 0, 'orphan tool_result without tool_use produces no span');
});

test('F153 Phase J AC-J8: tool_use without matching tool_result is silently skipped (still open at restore)', () => {
  const events = [
    {
      id: 'tool-open',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'use-open',
      tracing: tracing('t-x', 's-x'),
      startTimeMs: 7_000,
      timestamp: 7_000,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 8_000);
  assert.equal(dtos.length, 0, 'tool_use without tool_result (still open / lost) produces no span');
});

test('F153 Phase J AC-J8 (砚砚 R1 P2-1 fix): tool_result MISSING status is skipped (four-piece set)', () => {
  // Distinct from explicit `status: 'unknown'` (which is honest ambiguity and maps to UNSET).
  // A tool_result that simply omits the field means the producer never set it — provider
  // wiring is incomplete; honoring KD-41 honesty means we skip rather than fake UNSET.
  const events = [
    {
      id: 'tool-missing-status',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'use-no-status',
      tracing: tracing('t-m', 's-m'),
      startTimeMs: 100,
      timestamp: 100,
    },
    {
      id: 'toolr-missing-status',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-no-status',
      // NO status field — producer not yet wired
      tracing: tracing('t-m', 's-m'),
      endTimeMs: 250,
      timestamp: 250,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 500);
  assert.equal(dtos.length, 0, 'missing status (not "unknown") → skip per KD-41 honesty');
});

test('F153 Phase J AC-J8 (云端 Codex P2 fix): duplicate tool_use preserves FIRST entry', () => {
  // Mirrors ToolSpanTracker.start() first-wins semantics. A re-emitted tool_use
  // should NOT overwrite the earlier startTimeMs (which would shrink span duration
  // or even drop the pair when duplicate timestamp lands after the result).
  const events = [
    {
      id: 'tool-first',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'dup',
      tracing: tracing('t-d', 's-d', 'p-d'),
      startTimeMs: 1_000, // ← FIRST (should win)
      timestamp: 1_000,
    },
    {
      id: 'tool-dup',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'dup',
      tracing: tracing('t-d', 's-d-LATER', 'p-d'),
      startTimeMs: 1_500, // ← later, must NOT overwrite
      timestamp: 1_500,
    },
    {
      id: 'toolr-dup',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'dup',
      status: 'ok',
      tracing: tracing('t-d', 's-d', 'p-d'),
      endTimeMs: 2_000,
      timestamp: 2_000,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 3_000);
  assert.equal(dtos.length, 1, 'one span per id');
  const [dto] = dtos;
  assert.equal(dto.startTimeMs, 1_000, 'FIRST tool_use timestamp wins');
  assert.equal(dto.durationMs, 1_000, 'duration uses first start (2000-1000=1000), not second (2000-1500=500)');
  assert.equal(dto.spanId, 's-d', 'first span context wins (not s-d-LATER)');
});

test('F153 Phase J AC-J8: zero / negative duration is rejected (sanity guard)', () => {
  const events = [
    {
      id: 'tool-bad',
      type: 'tool_use',
      label: 'opus → mcp:cat-cafe/post_message',
      toolUseId: 'use-bad',
      tracing: tracing('t-b', 's-b'),
      startTimeMs: 9_000,
      timestamp: 9_000,
    },
    {
      id: 'toolr-bad',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-bad',
      status: 'ok',
      tracing: tracing('t-b', 's-b'),
      endTimeMs: 9_000, // same as start → 0 duration
      timestamp: 9_000,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 10_000);
  assert.equal(dtos.length, 0, 'zero-duration pair is rejected (sanity guard)');
});

test('F153 Phase J AC-J8: multiple tool calls in one message produce independent spans', () => {
  const events = [
    {
      id: 'tool-a',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'A',
      tracing: tracing('t-shared', 's-A', 'p-inv'),
      startTimeMs: 10,
      timestamp: 10,
    },
    {
      id: 'tool-b',
      type: 'tool_use',
      label: 'opus → mcp:cat-cafe/list_threads',
      toolUseId: 'B',
      tracing: tracing('t-shared', 's-B', 'p-inv'),
      startTimeMs: 20,
      timestamp: 20,
    },
    {
      id: 'toolr-b',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'B',
      status: 'ok',
      tracing: tracing('t-shared', 's-B', 'p-inv'),
      endTimeMs: 25,
      timestamp: 25,
    },
    {
      id: 'toolr-a',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'A',
      status: 'error',
      tracing: tracing('t-shared', 's-A', 'p-inv'),
      endTimeMs: 30,
      timestamp: 30,
    },
  ];

  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 1_000);
  assert.equal(dtos.length, 2, 'two pairs → two spans');
  const aDto = dtos.find((d) => d.attributes['tool.use_id'] === 'A');
  const bDto = dtos.find((d) => d.attributes['tool.use_id'] === 'B');
  assert.equal(aDto.durationMs, 20, 'A: 30-10');
  assert.equal(aDto.status.code, 2, 'A: ERROR');
  assert.equal(aDto.name, 'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_post_message');
  assert.equal(bDto.durationMs, 5, 'B: 25-20');
  assert.equal(bDto.status.code, 1, 'B: OK');
  assert.equal(bDto.name, 'cat_cafe.tool_use mcp:cat-cafe/list_threads');
});

test('F153 Phase J AC-J7 schema: StoredToolEvent backward compat — old events (no new fields) still load', () => {
  // Spec/regression guard: events without Phase J wiring (legacy) must not cause errors,
  // they just produce no synthesized span.
  const events = [
    {
      id: 'tool-old',
      type: 'tool_use',
      label: 'opus → some_tool',
      detail: 'some json',
      timestamp: 500,
    },
    {
      id: 'toolr-old',
      type: 'tool_result',
      label: 'opus ← result',
      detail: 'output text',
      timestamp: 600,
    },
  ];
  const dtos = synthesizeToolSpansFromEvents(events, 'opus', 700);
  assert.equal(dtos.length, 0, 'legacy events without new fields are silently no-op');
});

// ── maintainer R3 P2 regression: tool span synthesis must NOT be gated by msg-level tracing ──

const { hydrateTraceStoreFromRedis } = await import('../../dist/infrastructure/telemetry/hydrate-traces.js');
const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

/**
 * Minimal RedisClient mock for hydrate tests. Implements the two methods
 * used by hydrateTraceStoreFromRedis: zrevrangebyscore + pipeline+hmget+exec.
 */
function makeMockRedis(messages) {
  const ids = messages.map((m) => m.id);
  return {
    zrevrangebyscore: async () => ids,
    pipeline: () => {
      const calls = [];
      return {
        hmget(_key, ..._fields) {
          // We always pull (extra, timestamp, catId, metadata, toolEvents) per hydrate's contract.
          calls.push(_key);
          return this;
        },
        async exec() {
          return messages.map((m) => [
            null,
            [m.extra ?? null, String(m.timestamp), m.catId ?? null, m.metadata ?? null, m.toolEvents ?? null],
          ]);
        },
      };
    },
  };
}

test('F153 Phase J AC-J8 (maintainer R3 P2 fix): error/tool-only record (no extra.tracing) still synthesizes tool spans', async () => {
  // Use recent timestamps so LocalTraceStore.hydrate (24h cutoff) keeps them.
  const now = Date.now();
  const start = now - 5_000;
  const end = start + 120;

  const toolEvents = JSON.stringify([
    {
      id: 'tool-1',
      type: 'tool_use',
      label: 'opus → mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'use-err-1',
      tracing: { traceId: 't-err', spanId: 's-err', parentSpanId: 'p-inv' },
      startTimeMs: start,
      timestamp: start,
    },
    {
      id: 'toolr-1',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-err-1',
      status: 'error',
      tracing: { traceId: 't-err', spanId: 's-err', parentSpanId: 'p-inv' },
      endTimeMs: end,
      timestamp: end,
    },
  ]);

  // Simulate the route-fallback persistence: extra.stream present (invocation
  // correlation) but extra.tracing ABSENT (no done event arrived because of
  // hadError && empty text). Per maintainer R3: these are exactly the records
  // that need their toolEvents recovered on refresh; the old guard would drop
  // them silently.
  const extraNoTracing = JSON.stringify({ stream: { invocationId: 'inv-err-1' } });

  const redis = makeMockRedis([
    {
      id: 'msg-error-tool-only',
      extra: extraNoTracing,
      timestamp: now - 100,
      catId: 'opus',
      metadata: null,
      toolEvents,
    },
  ]);

  const store = new LocalTraceStore();
  await hydrateTraceStoreFromRedis(store, redis);

  assert.equal(store.stats().spanCount, 1, 'one tool span synthesized even without msg-level extra.tracing');
  const spans = store.query({});
  assert.equal(spans[0].name, 'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_post_message');
  assert.equal(spans[0].durationMs, 120, 'real duration 120ms');
  assert.equal(spans[0].status.code, 2, 'error → OTel ERROR=2');
});

test('F153 Phase J AC-J8: record WITH msg-level tracing produces invocation.restored + tool spans', async () => {
  const now = Date.now();
  const ts = now - 100;
  const extraWithTracing = JSON.stringify({
    tracing: { traceId: 't-inv', spanId: 's-inv', parentSpanId: 'p-route' },
    stream: { invocationId: 'inv-1' },
  });
  const toolEvents = JSON.stringify([
    {
      id: 'tool-x',
      type: 'tool_use',
      label: 'opus → mcp:cat-cafe/list_threads',
      toolUseId: 'use-x',
      tracing: { traceId: 't-inv', spanId: 's-tool', parentSpanId: 's-inv' },
      startTimeMs: ts - 300,
      timestamp: ts - 300,
    },
    {
      id: 'toolr-x',
      type: 'tool_result',
      label: 'opus ← result',
      toolUseId: 'use-x',
      status: 'ok',
      tracing: { traceId: 't-inv', spanId: 's-tool', parentSpanId: 's-inv' },
      endTimeMs: ts - 200,
      timestamp: ts - 200,
    },
  ]);
  const redis = makeMockRedis([
    {
      id: 'msg-with-tracing',
      extra: extraWithTracing,
      timestamp: ts,
      catId: 'opus',
      metadata: JSON.stringify({ usage: { durationMs: 100 } }),
      toolEvents,
    },
  ]);
  const store = new LocalTraceStore();
  await hydrateTraceStoreFromRedis(store, redis);
  const spans = store.query({});
  assert.equal(spans.length, 2, 'one invocation.restored + one tool_use');
  const invocationSpan = spans.find((s) => s.name === 'cat_cafe.invocation.restored');
  const toolSpan = spans.find((s) => s.name.startsWith('cat_cafe.tool_use '));
  assert.ok(invocationSpan, 'invocation.restored present (msg-level tracing OK)');
  assert.ok(toolSpan, 'tool span synthesized');
});

test('F153 Phase J AC-J8: record without tracing AND without toolEvents is a no-op (no fake DTOs)', async () => {
  const redis = makeMockRedis([
    {
      id: 'msg-empty',
      extra: null,
      timestamp: Date.now() - 100,
      catId: 'opus',
      metadata: null,
      toolEvents: null,
    },
  ]);
  const store = new LocalTraceStore();
  await hydrateTraceStoreFromRedis(store, redis);
  assert.equal(store.stats().spanCount, 0, 'no DTOs synthesized for empty record');
});

// =============================================================================
// R6 maintainer fix: hydrate prefers persisted `toolName` data field, decoupling
// from UI/display `label` parsing. Label remains as legacy fallback for stored
// events that predate this field.
// =============================================================================

test('R6: toolName data field is preferred over label — label format change does NOT degrade span name', () => {
  // Simulate a stored event where the UI label format has been changed (e.g.
  // arrow swapped, catId prefix dropped, label localized) but the persisted
  // `toolName` data field still carries the truth.
  const events = [
    {
      id: 'tool-r6-a',
      type: 'tool_use',
      // Label format intentionally different from the legacy "{catId} → {toolName}"
      // pattern — could be localized, shortened, or swapped to a colon delimiter.
      // Hydrate must NOT parse this; it must use the toolName field instead.
      label: '🐾 工具调用：发送消息（已脱敏）',
      toolName: 'mcp__cat-cafe__cat_cafe_post_message',
      toolUseId: 'r6-use-a',
      tracing: tracing('t-r6a', 's-r6a', 'p-r6'),
      startTimeMs: 5_000,
      timestamp: 5_000,
    },
    {
      id: 'toolr-r6-a',
      type: 'tool_result',
      label: '🐾 结果',
      toolUseId: 'r6-use-a',
      status: 'ok',
      tracing: tracing('t-r6a', 's-r6a', 'p-r6'),
      endTimeMs: 5_120,
      timestamp: 5_120,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'opus', 6_000);
  assert.equal(
    dto.name,
    'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_post_message',
    'span name derives from toolName data field, NOT from parsing label',
  );
  assert.equal(dto.durationMs, 120, 'duration still computed from start/end');
  assert.equal(dto.status.code, 1, 'OK status preserved');
});

test('R6: legacy stored event without toolName falls back to parsing label (backward compat)', () => {
  // Pre-R6 stored events have no `toolName` field. Hydrate must still recover
  // the tool name by parsing the legacy "{catId} → {toolName}" label format.
  const events = [
    {
      id: 'tool-legacy',
      type: 'tool_use',
      // Note: NO toolName field — simulating a stored event written before R6.
      label: 'sonnet → mcp__cat-cafe__cat_cafe_list_threads',
      toolUseId: 'legacy-use',
      tracing: tracing('t-leg', 's-leg', 'p-leg'),
      startTimeMs: 7_000,
      timestamp: 7_000,
    },
    {
      id: 'toolr-legacy',
      type: 'tool_result',
      label: 'sonnet ← result',
      toolUseId: 'legacy-use',
      status: 'ok',
      tracing: tracing('t-leg', 's-leg', 'p-leg'),
      endTimeMs: 7_080,
      timestamp: 7_080,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'sonnet', 8_000);
  assert.equal(
    dto.name,
    'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_list_threads',
    'legacy fallback parses label "{catId} → {toolName}" when toolName absent',
  );
});

test('R6: legacy stored event without toolName AND label missing arrow → unknown (last-resort fallback)', () => {
  // Edge case: legacy stored event where label parsing also fails (no arrow).
  // Must degrade gracefully to 'unknown' rather than throwing or producing
  // a malformed span name.
  const events = [
    {
      id: 'tool-malformed',
      type: 'tool_use',
      label: 'malformed label without arrow',
      toolUseId: 'mal-use',
      tracing: tracing('t-mal', 's-mal'),
      startTimeMs: 11_000,
      timestamp: 11_000,
    },
    {
      id: 'toolr-malformed',
      type: 'tool_result',
      label: 'result',
      toolUseId: 'mal-use',
      status: 'ok',
      tracing: tracing('t-mal', 's-mal'),
      endTimeMs: 11_050,
      timestamp: 11_050,
    },
  ];

  const [dto] = synthesizeToolSpansFromEvents(events, 'opus', 12_000);
  assert.equal(dto.name, 'cat_cafe.tool_use unknown', 'last-resort fallback to unknown');
});
