/**
 * F192 Phase D — C2 void-hold per-fire sample extractor tests.
 *
 * Verdict 2026-06-10-eval-a2a-c2-void-hold-samples-build acceptance: each finding
 * for `c2.void_hold_hint_emitted` must carry per-fire sample refs (HMAC ids,
 * span/trace ids, labels, firedAt). Mirrors the verdict-without-pass extractor
 * (PR #2144) — discipline single-sourced via `extractPerFireSamples`.
 *
 * Tests lock:
 *   - filters on the right event name (`c2.void_hold_fired`)
 *   - ordering firedAt desc → spanId asc
 *   - cap discipline: per-trigger ≤ 5, total ≤ 10
 *   - missing required attrs (messageId/trigger/threadId) → row skipped
 *   - verdict-without-pass events on the same span do NOT bleed into void-hold output
 *   - trigger values pass through unchanged (cn_chiqiu / en_hold_ball_underscore etc.)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { extractC2VoidHoldSamples, C2_VOID_HOLD_EVENT_NAME, DEFAULT_C2_VOID_HOLD_SAMPLE_CAP } = await import(
  '../../dist/infrastructure/harness-eval/c2-void-hold-sample-evidence.js'
);
const { C2_SAMPLE_EVENT_NAME } = await import('../../dist/infrastructure/harness-eval/c2-sample-evidence.js');

function makeSpan({ spanId, traceId = 'trace-1', events = [], parentSpanId } = {}) {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events,
  };
}

function makeVoidHoldEvent({
  timeMs,
  messageId = 'hash-msg',
  invocationId = 'hash-inv',
  threadId = 'hash-thread',
  agentId = 'opus-47',
  threadSystemKind = 'product',
  trigger = 'cn_chiqiu',
} = {}) {
  return {
    name: C2_VOID_HOLD_EVENT_NAME,
    timeMs,
    attributes: {
      messageId,
      invocationId,
      threadId,
      'agent.id': agentId,
      'thread.system_kind': threadSystemKind,
      trigger,
    },
  };
}

test('exports the canonical void-hold event name', () => {
  assert.equal(C2_VOID_HOLD_EVENT_NAME, 'c2.void_hold_fired');
});

test('extractC2VoidHoldSamples: empty spans → []', () => {
  assert.deepEqual(extractC2VoidHoldSamples([]), []);
});

test('extractC2VoidHoldSamples: spans with no events → []', () => {
  assert.deepEqual(extractC2VoidHoldSamples([makeSpan({ spanId: 's1' })]), []);
});

test('extracts a single void-hold fire with full attrs', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [makeVoidHoldEvent({ timeMs: 1000, trigger: 'cn_wo_chi_qiu' })],
  });
  const samples = extractC2VoidHoldSamples([span]);
  assert.equal(samples.length, 1);
  const [s] = samples;
  assert.equal(s.traceId, 'trace-1');
  assert.equal(s.spanId, 's1');
  assert.equal(s.messageIdHash, 'hash-msg');
  assert.equal(s.invocationIdHash, 'hash-inv');
  assert.equal(s.threadIdHash, 'hash-thread');
  assert.equal(s.agentId, 'opus-47');
  assert.equal(s.threadSystemKind, 'product');
  assert.equal(s.trigger, 'cn_wo_chi_qiu');
  assert.equal(s.firedAt, new Date(1000).toISOString());
});

test('filters out verdict-without-pass events on the same span (no bleed)', () => {
  // A turn might fire BOTH verdict-without-pass and void-hold; the void-hold
  // extractor must only see void-hold events.
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_SAMPLE_EVENT_NAME, // verdict_without_pass, should be filtered out
        timeMs: 1000,
        attributes: {
          messageId: 'hash-msg-v',
          invocationId: 'hash-inv-v',
          threadId: 'hash-thread-v',
          'agent.id': 'codex',
          'thread.system_kind': 'product',
          trigger: 'reject',
        },
      },
      makeVoidHoldEvent({ timeMs: 1100, trigger: 'cn_chiqiu' }),
    ],
  });
  const samples = extractC2VoidHoldSamples([span]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].trigger, 'cn_chiqiu');
  assert.equal(samples[0].messageIdHash, 'hash-msg');
});

test('ordering: firedAt desc → spanId asc', () => {
  const samples = extractC2VoidHoldSamples([
    makeSpan({ spanId: 's2', events: [makeVoidHoldEvent({ timeMs: 1000 })] }),
    makeSpan({ spanId: 's1', events: [makeVoidHoldEvent({ timeMs: 1000 })] }),
    makeSpan({ spanId: 's3', events: [makeVoidHoldEvent({ timeMs: 2000 })] }),
  ]);
  assert.deepEqual(
    samples.map((s) => s.spanId),
    ['s3', 's1', 's2'],
  );
});

test('per-trigger cap: noisy bucket gets at most cap.perTrigger samples', () => {
  const spans = [];
  for (let i = 0; i < 8; i++) {
    spans.push(
      makeSpan({
        spanId: `s${i}`,
        events: [makeVoidHoldEvent({ timeMs: i * 100, trigger: 'cn_chiqiu' })],
      }),
    );
  }
  const samples = extractC2VoidHoldSamples(spans, { total: 100, perTrigger: 3 });
  assert.equal(samples.length, 3);
  assert.ok(samples.every((s) => s.trigger === 'cn_chiqiu'));
});

test('total cap caps across triggers', () => {
  const spans = [];
  const triggers = ['cn_chiqiu', 'mcp_tool_name', 'en_hold_ball_underscore'];
  for (let i = 0; i < 12; i++) {
    spans.push(
      makeSpan({
        spanId: `s${String(i).padStart(2, '0')}`,
        events: [makeVoidHoldEvent({ timeMs: i * 100, trigger: triggers[i % triggers.length] })],
      }),
    );
  }
  const samples = extractC2VoidHoldSamples(spans, { total: 5, perTrigger: 10 });
  assert.equal(samples.length, 5);
});

test('default cap shape: { total: 10, perTrigger: 5 }', () => {
  assert.equal(DEFAULT_C2_VOID_HOLD_SAMPLE_CAP.total, 10);
  assert.equal(DEFAULT_C2_VOID_HOLD_SAMPLE_CAP.perTrigger, 5);
});

test('row missing messageId is dropped (fail-closed parse)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_VOID_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          // messageId omitted
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'cn_chiqiu',
        },
      },
    ],
  });
  assert.deepEqual(extractC2VoidHoldSamples([span]), []);
});

test('row missing trigger is dropped (fail-closed parse)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_VOID_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-msg',
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          // trigger omitted
        },
      },
    ],
  });
  assert.deepEqual(extractC2VoidHoldSamples([span]), []);
});

test('row missing threadId is dropped (P1-3 thread_scope requirement)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_VOID_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-msg',
          invocationId: 'hash-inv',
          // threadId omitted
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'cn_chiqiu',
        },
      },
    ],
  });
  assert.deepEqual(extractC2VoidHoldSamples([span]), []);
});

test('preserves multiple HOLD_PATTERN trigger values verbatim', () => {
  const triggers = [
    'cn_chiqiu',
    'cn_wo_chi_qiu',
    'en_holdball_space',
    'en_hold_ball_underscore',
    'en_holding_the_ball',
    'mcp_tool_name',
  ];
  const spans = triggers.map((t, i) =>
    makeSpan({
      spanId: `s${String(i).padStart(2, '0')}`,
      events: [makeVoidHoldEvent({ timeMs: i * 100, trigger: t })],
    }),
  );
  const samples = extractC2VoidHoldSamples(spans);
  const seenTriggers = new Set(samples.map((s) => s.trigger));
  assert.deepEqual([...seenTriggers].sort(), [...triggers].sort());
});
