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
