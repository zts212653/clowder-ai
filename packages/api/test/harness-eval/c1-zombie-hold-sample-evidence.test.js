/**
 * F192 Phase D — C1 zombie-hold per-fire sample extractor tests.
 *
 * Verdict 2026-06-12-eval-a2a-c1-zombie-hold-samples-build (PR #2244): C1 finding
 * for `c1.zombie_hold_count` must carry per-fire sample refs (HMAC ids,
 * span/trace ids, labels, firedAt, wake-delay bucket trigger). Mirrors the C2
 * extractor pattern — discipline single-sourced via `extractPerFireSamples`.
 *
 * Tests lock:
 *   - filters on the right event name (`c1.zombie_hold_fired`)
 *   - ordering firedAt desc → spanId asc
 *   - cap discipline: per-trigger ≤ 5, total ≤ 10
 *   - missing required attrs (messageId/trigger/threadId) → row skipped
 *   - C2 events on the same span do NOT bleed into C1 output
 *   - all 4 WAKE_DELAY_BUCKETS pass through as trigger values
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { extractC1ZombieHoldSamples, C1_ZOMBIE_HOLD_EVENT_NAME, DEFAULT_C1_ZOMBIE_HOLD_SAMPLE_CAP } = await import(
  '../../dist/infrastructure/harness-eval/c1-zombie-hold-sample-evidence.js'
);
const { C2_SAMPLE_EVENT_NAME } = await import('../../dist/infrastructure/harness-eval/c2-sample-evidence.js');
const { C2_VOID_HOLD_EVENT_NAME } = await import(
  '../../dist/infrastructure/harness-eval/c2-void-hold-sample-evidence.js'
);

function makeSpan({ spanId, traceId = 'trace-1', events = [], parentSpanId } = {}) {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: 'cat_cafe.hold_ball_callback',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events,
  };
}

function makeZombieHoldEvent({
  timeMs,
  messageId = 'hash-prior-task',
  invocationId = 'hash-inv',
  threadId = 'hash-thread',
  agentId = 'opus-47',
  threadSystemKind = 'product',
  trigger = 'prior_imminent',
  priorTaskIdHash = 'hash-prior-task',
  newTaskIdHash = 'hash-new-task',
} = {}) {
  return {
    name: C1_ZOMBIE_HOLD_EVENT_NAME,
    timeMs,
    attributes: {
      messageId,
      invocationId,
      threadId,
      'agent.id': agentId,
      'thread.system_kind': threadSystemKind,
      trigger,
      priorTaskIdHash,
      newTaskIdHash,
    },
  };
}

test('exports the canonical C1 zombie-hold event name', () => {
  assert.equal(C1_ZOMBIE_HOLD_EVENT_NAME, 'c1.zombie_hold_fired');
});

test('extractC1ZombieHoldSamples: empty spans → []', () => {
  assert.deepEqual(extractC1ZombieHoldSamples([]), []);
});

test('extractC1ZombieHoldSamples: spans with no events → []', () => {
  assert.deepEqual(extractC1ZombieHoldSamples([makeSpan({ spanId: 's1' })]), []);
});

test('extracts a single zombie-hold fire with full attrs', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [makeZombieHoldEvent({ timeMs: 1000, trigger: 'prior_overdue' })],
  });
  const samples = extractC1ZombieHoldSamples([span]);
  assert.equal(samples.length, 1);
  const [s] = samples;
  assert.equal(s.traceId, 'trace-1');
  assert.equal(s.spanId, 's1');
  assert.equal(s.messageIdHash, 'hash-prior-task');
  assert.equal(s.invocationIdHash, 'hash-inv');
  assert.equal(s.threadIdHash, 'hash-thread');
  assert.equal(s.agentId, 'opus-47');
  assert.equal(s.threadSystemKind, 'product');
  assert.equal(s.trigger, 'prior_overdue');
  assert.equal(s.firedAt, new Date(1000).toISOString());
});

test('filters out C2 verdict-without-pass + void-hold events on the same span (no bleed)', () => {
  // A request burst might fire C1 + C2 events; the C1 extractor must only see C1.
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_SAMPLE_EVENT_NAME, // verdict_without_pass — must be filtered out
        timeMs: 900,
        attributes: {
          messageId: 'hash-msg-v',
          threadId: 'hash-thread-v',
          'agent.id': 'codex',
          'thread.system_kind': 'product',
          trigger: 'reject',
        },
      },
      {
        name: C2_VOID_HOLD_EVENT_NAME, // void-hold — must also be filtered out
        timeMs: 950,
        attributes: {
          messageId: 'hash-msg-vh',
          threadId: 'hash-thread-vh',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'cn_chiqiu',
        },
      },
      makeZombieHoldEvent({ timeMs: 1000, trigger: 'prior_short' }),
    ],
  });
  const samples = extractC1ZombieHoldSamples([span]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].trigger, 'prior_short');
  assert.equal(samples[0].messageIdHash, 'hash-prior-task');
});

test('ordering: firedAt desc → spanId asc', () => {
  const samples = extractC1ZombieHoldSamples([
    makeSpan({ spanId: 's2', events: [makeZombieHoldEvent({ timeMs: 1000 })] }),
    makeSpan({ spanId: 's1', events: [makeZombieHoldEvent({ timeMs: 1000 })] }),
    makeSpan({ spanId: 's3', events: [makeZombieHoldEvent({ timeMs: 2000 })] }),
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
        events: [makeZombieHoldEvent({ timeMs: i * 100, trigger: 'prior_imminent' })],
      }),
    );
  }
  const samples = extractC1ZombieHoldSamples(spans, { total: 100, perTrigger: 3 });
  assert.equal(samples.length, 3);
  assert.ok(samples.every((s) => s.trigger === 'prior_imminent'));
});

test('total cap caps across triggers', () => {
  const spans = [];
  const triggers = ['prior_overdue', 'prior_imminent', 'prior_short', 'prior_long'];
  for (let i = 0; i < 12; i++) {
    spans.push(
      makeSpan({
        spanId: `s${String(i).padStart(2, '0')}`,
        events: [makeZombieHoldEvent({ timeMs: i * 100, trigger: triggers[i % triggers.length] })],
      }),
    );
  }
  const samples = extractC1ZombieHoldSamples(spans, { total: 5, perTrigger: 10 });
  assert.equal(samples.length, 5);
});

test('default cap shape: { total: 10, perTrigger: 5 }', () => {
  assert.equal(DEFAULT_C1_ZOMBIE_HOLD_SAMPLE_CAP.total, 10);
  assert.equal(DEFAULT_C1_ZOMBIE_HOLD_SAMPLE_CAP.perTrigger, 5);
});

test('row missing messageId is dropped (fail-closed parse)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C1_ZOMBIE_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          // messageId omitted
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'prior_imminent',
        },
      },
    ],
  });
  assert.deepEqual(extractC1ZombieHoldSamples([span]), []);
});

test('row missing trigger is dropped (fail-closed parse)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C1_ZOMBIE_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-prior-task',
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          // trigger omitted
        },
      },
    ],
  });
  assert.deepEqual(extractC1ZombieHoldSamples([span]), []);
});

test('row missing threadId is dropped (P1-3 thread_scope requirement)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C1_ZOMBIE_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-prior-task',
          invocationId: 'hash-inv',
          // threadId omitted
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'prior_imminent',
        },
      },
    ],
  });
  assert.deepEqual(extractC1ZombieHoldSamples([span]), []);
});

test('R1 P1-1 (砚砚): priorTaskIdHash + newTaskIdHash survive into PerFireSample.extras', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      makeZombieHoldEvent({
        timeMs: 1000,
        priorTaskIdHash: 'hash-prior-task-explicit',
        newTaskIdHash: 'hash-new-task-explicit',
      }),
    ],
  });
  const samples = extractC1ZombieHoldSamples([span]);
  assert.equal(samples.length, 1);
  assert.ok(samples[0].extras, 'extras must be populated for C1 samples');
  assert.equal(samples[0].extras.priorTaskIdHash, 'hash-prior-task-explicit');
  assert.equal(samples[0].extras.newTaskIdHash, 'hash-new-task-explicit');
});

test('R1 P1-1: extras absent when neither extra attr is on the event (back-compat, no fabrication)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C1_ZOMBIE_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-prior-task',
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'prior_imminent',
          // priorTaskIdHash + newTaskIdHash both omitted
        },
      },
    ],
  });
  const samples = extractC1ZombieHoldSamples([span]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].extras, undefined, 'extras absent when no extra keys are present');
});

test('R1 P1-1: extras populated even if only one of priorTaskIdHash / newTaskIdHash is present (partial)', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C1_ZOMBIE_HOLD_EVENT_NAME,
        timeMs: 1000,
        attributes: {
          messageId: 'hash-prior-task',
          invocationId: 'hash-inv',
          threadId: 'hash-thread',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'prior_imminent',
          priorTaskIdHash: 'hash-prior-only',
          // newTaskIdHash intentionally omitted
        },
      },
    ],
  });
  const samples = extractC1ZombieHoldSamples([span]);
  assert.equal(samples.length, 1);
  assert.ok(samples[0].extras, 'extras populated when any allowlisted extra is present');
  assert.equal(samples[0].extras.priorTaskIdHash, 'hash-prior-only');
  assert.equal(samples[0].extras.newTaskIdHash, undefined, 'absent extras stay absent — no synthetic empty strings');
});

test('preserves all 4 WAKE_DELAY_BUCKETS as trigger values verbatim', () => {
  const triggers = ['prior_overdue', 'prior_imminent', 'prior_short', 'prior_long'];
  const spans = triggers.map((t, i) =>
    makeSpan({
      spanId: `s${String(i).padStart(2, '0')}`,
      events: [makeZombieHoldEvent({ timeMs: i * 100, trigger: t })],
    }),
  );
  const samples = extractC1ZombieHoldSamples(spans);
  const seenTriggers = new Set(samples.map((s) => s.trigger));
  assert.deepEqual([...seenTriggers].sort(), [...triggers].sort());
});
