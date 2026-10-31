/**
 * F192 Phase D — C2 per-fire sample extractor tests.
 *
 * Verdict 2026-06-08-eval-a2a-c2-sample-evidence-build acceptance: each finding
 * must carry per-fire sample refs (HMAC ids, span/trace ids, labels, firedAt).
 * Tests lock:
 *   - extraction filters to the right event name
 *   - ordering firedAt desc → spanId asc (deterministic, 砚砚-钉死)
 *   - cap discipline: per-trigger ≤ 5, total ≤ 10, overflow fills by firedAt
 *   - 06-08 shape (3 triggers × 1 fire) → all 3 surface
 *   - high-volume shape (1 noisy trigger > perTrigger) → cap enforced
 *   - missing required attrs (messageId/trigger) → row skipped
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { extractC2VerdictWithoutPassSamples, groupSamplesByTrigger, DEFAULT_C2_SAMPLE_CAP, C2_SAMPLE_EVENT_NAME } =
  await import('../../dist/infrastructure/harness-eval/c2-sample-evidence.js');

/** Build a minimal EvalTraceSpan with optional events. */
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

function makeFireEvent({
  timeMs,
  messageId = 'hash-msg',
  invocationId = 'hash-inv',
  threadId = 'hash-thread',
  agentId = 'codex',
  threadSystemKind = 'product',
  trigger = 'reject',
} = {}) {
  return {
    name: C2_SAMPLE_EVENT_NAME,
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

test('extractC2VerdictWithoutPassSamples: empty spans → []', () => {
  assert.deepEqual(extractC2VerdictWithoutPassSamples([]), []);
});

test('extractC2VerdictWithoutPassSamples: no matching event → []', () => {
  const spans = [makeSpan({ spanId: 's1', events: [{ name: 'other.event', timeMs: 1, attributes: {} }] })];
  assert.deepEqual(extractC2VerdictWithoutPassSamples(spans), []);
});

test('extractC2VerdictWithoutPassSamples: 06-08 shape — 3 triggers × 1 fire each → all 3 surface', () => {
  const spans = [
    makeSpan({
      spanId: 's-a',
      events: [makeFireEvent({ timeMs: 1000, trigger: 'reject', messageId: 'h-a' })],
    }),
    makeSpan({
      spanId: 's-b',
      events: [makeFireEvent({ timeMs: 2000, trigger: 'approve_cn', messageId: 'h-b' })],
    }),
    makeSpan({
      spanId: 's-c',
      events: [makeFireEvent({ timeMs: 3000, trigger: 'p1p2', messageId: 'h-c' })],
    }),
  ];
  const out = extractC2VerdictWithoutPassSamples(spans);
  assert.equal(out.length, 3);
  // Ordering: firedAt desc (timeMs 3000 > 2000 > 1000)
  assert.equal(out[0].trigger, 'p1p2');
  assert.equal(out[1].trigger, 'approve_cn');
  assert.equal(out[2].trigger, 'reject');
  // Schema integrity
  assert.equal(out[0].spanId, 's-c');
  assert.equal(out[0].traceId, 'trace-1');
  assert.equal(out[0].messageIdHash, 'h-c');
  assert.equal(out[0].agentId, 'codex');
  assert.equal(out[0].threadSystemKind, 'product');
  assert.ok(out[0].firedAt.endsWith('Z'), 'firedAt should be ISO UTC');
});

test('extractC2VerdictWithoutPassSamples: firedAt tie → spanId asc tiebreak', () => {
  const spans = [
    makeSpan({ spanId: 'b', events: [makeFireEvent({ timeMs: 5000, trigger: 'reject', messageId: 'h-b' })] }),
    makeSpan({ spanId: 'a', events: [makeFireEvent({ timeMs: 5000, trigger: 'approve_cn', messageId: 'h-a' })] }),
  ];
  const out = extractC2VerdictWithoutPassSamples(spans);
  assert.equal(out[0].spanId, 'a', 'tiebreak: spanId asc means a before b');
  assert.equal(out[1].spanId, 'b');
});

test('extractC2VerdictWithoutPassSamples: per-trigger cap = 5 enforced before total cap', () => {
  // 7 reject fires + 1 p1p2 fire → per-trigger cap should keep 5 reject + 1 p1p2 = 6
  const spans = [];
  for (let i = 0; i < 7; i++) {
    spans.push(makeSpan({ spanId: `r${i}`, events: [makeFireEvent({ timeMs: 1000 + i, trigger: 'reject' })] }));
  }
  spans.push(makeSpan({ spanId: 'p1', events: [makeFireEvent({ timeMs: 9000, trigger: 'p1p2' })] }));

  const out = extractC2VerdictWithoutPassSamples(spans);
  const byTrigger = groupSamplesByTrigger(out);
  assert.equal((byTrigger.reject ?? []).length, 5, 'reject bucket capped at perTrigger=5');
  assert.equal((byTrigger.p1p2 ?? []).length, 1, 'p1p2 bucket has 1 fire surfaced');
  assert.equal(out.length, 6, 'total = 5 + 1 = 6 within total=10 cap');
});

test('extractC2VerdictWithoutPassSamples: total cap = 10 enforced across buckets', () => {
  // 12 fires across 3 triggers: 5 + 5 + 2 = 12 raw; per-trigger keeps 5+5+2=12,
  // total cap clips to 10 (newest first by firedAt).
  const spans = [];
  for (let i = 0; i < 5; i++) {
    spans.push(makeSpan({ spanId: `r${i}`, events: [makeFireEvent({ timeMs: 100 + i, trigger: 'reject' })] }));
  }
  for (let i = 0; i < 5; i++) {
    spans.push(makeSpan({ spanId: `a${i}`, events: [makeFireEvent({ timeMs: 200 + i, trigger: 'approve_cn' })] }));
  }
  for (let i = 0; i < 2; i++) {
    spans.push(makeSpan({ spanId: `p${i}`, events: [makeFireEvent({ timeMs: 300 + i, trigger: 'p1p2' })] }));
  }
  const out = extractC2VerdictWithoutPassSamples(spans);
  assert.equal(out.length, 10, 'total capped at 10');
});

test('extractC2VerdictWithoutPassSamples: per-trigger overflow discarded (strict cap, no promotion)', () => {
  // 8 reject (perTrigger=5 → 3 dropped) + 1 p1p2 = 9 raw.
  // Strict per-trigger: 5 reject kept (newest 5) + 1 p1p2 = 6 final.
  // Overflow (3 oldest reject) is DISCARDED, not used to fill remaining total slots —
  // protects against noisy trigger starvation of other buckets.
  const spans = [];
  for (let i = 0; i < 8; i++) {
    spans.push(makeSpan({ spanId: `r${i}`, events: [makeFireEvent({ timeMs: 1000 + i, trigger: 'reject' })] }));
  }
  spans.push(makeSpan({ spanId: 'p1', events: [makeFireEvent({ timeMs: 9000, trigger: 'p1p2' })] }));

  const out = extractC2VerdictWithoutPassSamples(spans);
  assert.equal(out.length, 6, '5 reject (newest) + 1 p1p2 = 6 final (3 reject overflow dropped)');
  const byTrigger = groupSamplesByTrigger(out);
  assert.equal((byTrigger.reject ?? []).length, 5, 'strict per-trigger cap, NOT 8');
  assert.equal((byTrigger.p1p2 ?? []).length, 1);
});

test('extractC2VerdictWithoutPassSamples: missing required attrs → row skipped (local R1 P1-3: threadId required)', () => {
  const spans = [
    // Missing messageId
    makeSpan({
      spanId: 's-no-msg',
      events: [
        {
          name: C2_SAMPLE_EVENT_NAME,
          timeMs: 1000,
          attributes: { invocationId: 'h-inv', threadId: 'h-thread', trigger: 'reject', 'agent.id': 'codex' },
        },
      ],
    }),
    // Missing trigger
    makeSpan({
      spanId: 's-no-trigger',
      events: [
        {
          name: C2_SAMPLE_EVENT_NAME,
          timeMs: 1000,
          attributes: { messageId: 'h-msg', invocationId: 'h-inv', threadId: 'h-thread', 'agent.id': 'codex' },
        },
      ],
    }),
    // Missing threadId — drilldown helper has no scope to honor → skip
    makeSpan({
      spanId: 's-no-thread',
      events: [
        {
          name: C2_SAMPLE_EVENT_NAME,
          timeMs: 1000,
          attributes: { messageId: 'h-msg', invocationId: 'h-inv', trigger: 'reject', 'agent.id': 'codex' },
        },
      ],
    }),
    // Valid
    makeSpan({ spanId: 's-ok', events: [makeFireEvent({ timeMs: 2000 })] }),
  ];
  const out = extractC2VerdictWithoutPassSamples(spans);
  assert.equal(out.length, 1, 'only the well-formed sample survives');
  assert.equal(out[0].spanId, 's-ok');
});

test('extractC2VerdictWithoutPassSamples: DEFAULT_C2_SAMPLE_CAP is 10 total / 5 per-trigger (frozen)', () => {
  assert.equal(DEFAULT_C2_SAMPLE_CAP.total, 10);
  assert.equal(DEFAULT_C2_SAMPLE_CAP.perTrigger, 5);
});
