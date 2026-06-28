/**
 * F192 Phase D — C1 hold per-fire sample extractor tests.
 *
 * F192 verdict `2026-06-18-eval-a2a-c1-zombie-hold-semantics-fix` split the
 * single `c1.zombie_hold_*` surface into bucket-routed pairs:
 *   - `c1.hold_zombie_*`      (actionable: prior_overdue / prior_imminent)
 *   - `c1.hold_replacement_*` (benign: prior_short / prior_long)
 *
 * Tests lock both extractors share:
 *   - canonical event name (c1.hold_zombie_fired / c1.hold_replacement_fired)
 *   - ordering firedAt desc → spanId asc
 *   - cap discipline: per-trigger ≤ 5, total ≤ 10 (shared default cap)
 *   - missing required attrs (messageId/trigger/threadId) → row skipped
 *   - C2 events on the same span do NOT bleed into C1 output
 *   - cross-bucket bleed: the zombie extractor must NOT pick up replacement
 *     events and vice-versa (the producer guarantees one event per
 *     cancellation; this guards against future extractor regressions)
 *   - priorTaskIdHash + newTaskIdHash flow through `extras` allowlist (P1-1)
 *
 * Parameterized over both extractors so the shared discipline is single-sourced
 * (mirrors the producer's KD-24 mechanical bucket routing).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  extractC1HoldZombieSamples,
  extractC1HoldReplacementSamples,
  C1_HOLD_ZOMBIE_EVENT_NAME,
  C1_HOLD_REPLACEMENT_EVENT_NAME,
  DEFAULT_C1_HOLD_SAMPLE_CAP,
} = await import('../../dist/infrastructure/harness-eval/c1-hold-sample-evidence.js');
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

function makeC1Event(
  eventName,
  {
    timeMs,
    messageId = 'hash-prior-task',
    invocationId = 'hash-inv',
    threadId = 'hash-thread',
    agentId = 'opus-47',
    threadSystemKind = 'product',
    trigger = eventName === 'c1.hold_zombie_fired' ? 'prior_imminent' : 'prior_long',
    priorTaskIdHash = 'hash-prior-task',
    newTaskIdHash = 'hash-new-task',
  } = {},
) {
  return {
    name: eventName,
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

// ── Canonical event names + default cap (locked) ───────────────────────────

test('exports the canonical C1 zombie + replacement event names', () => {
  assert.equal(C1_HOLD_ZOMBIE_EVENT_NAME, 'c1.hold_zombie_fired');
  assert.equal(C1_HOLD_REPLACEMENT_EVENT_NAME, 'c1.hold_replacement_fired');
});

test('default cap shape: { total: 10, perTrigger: 5 } shared across both extractors', () => {
  assert.equal(DEFAULT_C1_HOLD_SAMPLE_CAP.total, 10);
  assert.equal(DEFAULT_C1_HOLD_SAMPLE_CAP.perTrigger, 5);
});

// ── Parameterized: same discipline for both extractors ─────────────────────

const VARIANTS = [
  { name: 'zombie', extract: () => extractC1HoldZombieSamples, eventName: 'c1.hold_zombie_fired' },
  { name: 'replacement', extract: () => extractC1HoldReplacementSamples, eventName: 'c1.hold_replacement_fired' },
];

for (const v of VARIANTS) {
  test(`[${v.name}] empty spans → []`, () => {
    assert.deepEqual(v.extract()([]), []);
  });

  test(`[${v.name}] spans with no events → []`, () => {
    assert.deepEqual(v.extract()([makeSpan({ spanId: 's1' })]), []);
  });

  test(`[${v.name}] extracts a single fire with full attrs`, () => {
    const span = makeSpan({
      spanId: 's1',
      events: [makeC1Event(v.eventName, { timeMs: 1000 })],
    });
    const samples = v.extract()([span]);
    assert.equal(samples.length, 1);
    const [s] = samples;
    assert.equal(s.traceId, 'trace-1');
    assert.equal(s.spanId, 's1');
    assert.equal(s.messageIdHash, 'hash-prior-task');
    assert.equal(s.invocationIdHash, 'hash-inv');
    assert.equal(s.threadIdHash, 'hash-thread');
    assert.equal(s.agentId, 'opus-47');
    assert.equal(s.threadSystemKind, 'product');
    assert.equal(s.firedAt, new Date(1000).toISOString());
  });

  test(`[${v.name}] ordering: firedAt desc → spanId asc`, () => {
    const samples = v.extract()([
      makeSpan({ spanId: 's2', events: [makeC1Event(v.eventName, { timeMs: 1000 })] }),
      makeSpan({ spanId: 's1', events: [makeC1Event(v.eventName, { timeMs: 1000 })] }),
      makeSpan({ spanId: 's3', events: [makeC1Event(v.eventName, { timeMs: 2000 })] }),
    ]);
    assert.deepEqual(
      samples.map((s) => s.spanId),
      ['s3', 's1', 's2'],
    );
  });

  test(`[${v.name}] per-trigger cap: noisy bucket gets at most cap.perTrigger samples`, () => {
    const spans = [];
    const trigger = v.name === 'zombie' ? 'prior_imminent' : 'prior_long';
    for (let i = 0; i < 8; i++) {
      spans.push(
        makeSpan({
          spanId: `s${i}`,
          events: [makeC1Event(v.eventName, { timeMs: i * 100, trigger })],
        }),
      );
    }
    const samples = v.extract()(spans, { total: 100, perTrigger: 3 });
    assert.equal(samples.length, 3);
    assert.ok(samples.every((s) => s.trigger === trigger));
  });

  test(`[${v.name}] missing messageId is dropped (fail-closed parse)`, () => {
    const span = makeSpan({
      spanId: 's1',
      events: [
        {
          name: v.eventName,
          timeMs: 1000,
          attributes: {
            invocationId: 'hash-inv',
            threadId: 'hash-thread',
            'agent.id': 'opus-47',
            'thread.system_kind': 'product',
            trigger: 'prior_imminent',
          },
        },
      ],
    });
    assert.deepEqual(v.extract()([span]), []);
  });

  test(`[${v.name}] missing trigger is dropped (fail-closed parse)`, () => {
    const span = makeSpan({
      spanId: 's1',
      events: [
        {
          name: v.eventName,
          timeMs: 1000,
          attributes: {
            messageId: 'hash-prior-task',
            invocationId: 'hash-inv',
            threadId: 'hash-thread',
            'agent.id': 'opus-47',
            'thread.system_kind': 'product',
          },
        },
      ],
    });
    assert.deepEqual(v.extract()([span]), []);
  });

  test(`[${v.name}] missing threadId is dropped (P1-3 thread_scope requirement)`, () => {
    const span = makeSpan({
      spanId: 's1',
      events: [
        {
          name: v.eventName,
          timeMs: 1000,
          attributes: {
            messageId: 'hash-prior-task',
            invocationId: 'hash-inv',
            'agent.id': 'opus-47',
            'thread.system_kind': 'product',
            trigger: 'prior_imminent',
          },
        },
      ],
    });
    assert.deepEqual(v.extract()([span]), []);
  });

  test(`[${v.name}] priorTaskIdHash + newTaskIdHash survive into PerFireSample.extras (R1 P1-1)`, () => {
    const span = makeSpan({
      spanId: 's1',
      events: [
        makeC1Event(v.eventName, {
          timeMs: 1000,
          priorTaskIdHash: 'hash-prior-task-explicit',
          newTaskIdHash: 'hash-new-task-explicit',
        }),
      ],
    });
    const samples = v.extract()([span]);
    assert.equal(samples.length, 1);
    assert.ok(samples[0].extras, 'extras must be populated');
    assert.equal(samples[0].extras.priorTaskIdHash, 'hash-prior-task-explicit');
    assert.equal(samples[0].extras.newTaskIdHash, 'hash-new-task-explicit');
  });
}

// ── Cross-event bleed (split-isolation guard) ──────────────────────────────

test('zombie extractor does NOT pick up c1.hold_replacement_fired on the same span', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      makeC1Event('c1.hold_replacement_fired', { timeMs: 900, trigger: 'prior_long' }),
      makeC1Event('c1.hold_zombie_fired', { timeMs: 1000, trigger: 'prior_overdue' }),
    ],
  });
  const samples = extractC1HoldZombieSamples([span]);
  assert.equal(samples.length, 1, 'zombie extractor must only see zombie events');
  assert.equal(samples[0].trigger, 'prior_overdue');
});

test('replacement extractor does NOT pick up c1.hold_zombie_fired on the same span', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      makeC1Event('c1.hold_zombie_fired', { timeMs: 900, trigger: 'prior_imminent' }),
      makeC1Event('c1.hold_replacement_fired', { timeMs: 1000, trigger: 'prior_short' }),
    ],
  });
  const samples = extractC1HoldReplacementSamples([span]);
  assert.equal(samples.length, 1, 'replacement extractor must only see replacement events');
  assert.equal(samples[0].trigger, 'prior_short');
});

// ── C2 cross-component bleed ───────────────────────────────────────────────

test('filters out C2 verdict-without-pass + void-hold events on the same span', () => {
  const span = makeSpan({
    spanId: 's1',
    events: [
      {
        name: C2_SAMPLE_EVENT_NAME,
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
        name: C2_VOID_HOLD_EVENT_NAME,
        timeMs: 950,
        attributes: {
          messageId: 'hash-msg-vh',
          threadId: 'hash-thread-vh',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'cn_chiqiu',
        },
      },
      makeC1Event('c1.hold_replacement_fired', { timeMs: 1000, trigger: 'prior_long' }),
    ],
  });
  const replacementSamples = extractC1HoldReplacementSamples([span]);
  assert.equal(replacementSamples.length, 1);
  assert.equal(replacementSamples[0].trigger, 'prior_long');
  assert.equal(replacementSamples[0].messageIdHash, 'hash-prior-task');
  const zombieSamples = extractC1HoldZombieSamples([span]);
  assert.equal(zombieSamples.length, 0, 'no zombie event on this span');
});

// ── Total cap across triggers (zombie variant) ─────────────────────────────

test('total cap caps across zombie-bucket triggers (overdue + imminent)', () => {
  const spans = [];
  const triggers = ['prior_overdue', 'prior_imminent'];
  for (let i = 0; i < 12; i++) {
    spans.push(
      makeSpan({
        spanId: `s${String(i).padStart(2, '0')}`,
        events: [makeC1Event('c1.hold_zombie_fired', { timeMs: i * 100, trigger: triggers[i % triggers.length] })],
      }),
    );
  }
  const samples = extractC1HoldZombieSamples(spans, { total: 5, perTrigger: 10 });
  assert.equal(samples.length, 5);
});

test('total cap caps across replacement-bucket triggers (short + long)', () => {
  const spans = [];
  const triggers = ['prior_short', 'prior_long'];
  for (let i = 0; i < 12; i++) {
    spans.push(
      makeSpan({
        spanId: `s${String(i).padStart(2, '0')}`,
        events: [makeC1Event('c1.hold_replacement_fired', { timeMs: i * 100, trigger: triggers[i % triggers.length] })],
      }),
    );
  }
  const samples = extractC1HoldReplacementSamples(spans, { total: 5, perTrigger: 10 });
  assert.equal(samples.length, 5);
});
