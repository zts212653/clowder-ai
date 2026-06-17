import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateF167Snapshot } from '../../dist/infrastructure/harness-eval/f167-eval.js';

const emptyInput = {
  traces: { spans: [], count: 0 },
  metrics: {},
  metricsHistory: { snapshots: [], count: 0 },
  traceStats: {
    spanCount: 0,
    maxSpans: 10000,
    maxAgeMs: 86400000,
    oldestStoredAt: null,
    newestStoredAt: null,
  },
};

describe('F167 Runtime Eval Snapshot', () => {
  it('produces snapshot with 4 components', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.featureId, 'F167');
    assert.equal(snapshot.components.length, 4);
    const ids = snapshot.components.map((c) => c.componentId).sort();
    assert.deepEqual(ids, ['C1', 'C2', 'L1', 'route-serial']);
  });

  it('includes metadata fields', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.dataSource, 'F153 /api/telemetry/*');
    assert.equal(snapshot.generatedBy, 'F192 Phase C eval');
    assert.ok(snapshot.generatedAt);
    assert.ok(snapshot.window);
    assert.equal(typeof snapshot.window.durationHours, 'number');
  });

  it('marks telemetry gaps for L1 (no counter)', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    const l1 = snapshot.components.find((c) => c.componentId === 'L1');
    assert.ok(l1.telemetryGaps.length > 0);
    assert.ok(l1.telemetryGaps.some((g) => g.reason === 'no_counter'));
    assert.equal(l1.confidence, 'no-data');
  });

  it('marks C1 gap for zombie/cancel counter', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.ok(c1.telemetryGaps.some((g) => g.reason === 'no_counter' && g.metric.includes('zombie')));
  });

  it('marks C2 hint counter as mixed', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    assert.ok(c2.telemetryGaps.some((g) => g.metric.includes('hint_emitted')));
  });

  it('extracts route-serial counters from bare metrics keys', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_inline_action_checked: 100,
        cat_cafe_a2a_inline_action_detected: 5,
        cat_cafe_a2a_inline_action_shadow_miss: 2,
        cat_cafe_a2a_line_start_detected: 80,
      },
      traceStats: {
        spanCount: 100,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const rs = snapshot.components.find((c) => c.componentId === 'route-serial');
    assert.equal(rs.activationCounts['inline_action.checked'], 100);
    assert.equal(rs.activationCounts['line_start.detected'], 80);
    assert.equal(rs.frictionCounts['inline_action.shadow_miss'], 2);
    assert.notEqual(rs.confidence, 'no-data');
  });

  it('extracts route-serial counters from Prometheus _total + labeled keys', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        'cat_cafe_a2a_inline_action_checked_total{agent_id="codex",otel_scope_name="cat-cafe-api",otel_scope_version="0.1.0"}': 8,
        'cat_cafe_a2a_inline_action_checked_total{agent_id="opus",otel_scope_name="cat-cafe-api",otel_scope_version="0.1.0"}': 7,
        'cat_cafe_a2a_inline_action_checked_total{agent_id="opus-47",otel_scope_name="cat-cafe-api",otel_scope_version="0.1.0"}': 4,
        'cat_cafe_a2a_line_start_detected_total{agent_id="codex",otel_scope_name="cat-cafe-api",otel_scope_version="0.1.0"}': 3,
        'cat_cafe_a2a_line_start_detected_total{agent_id="opus-47",otel_scope_name="cat-cafe-api",otel_scope_version="0.1.0"}': 2,
      },
      traceStats: {
        spanCount: 100,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const rs = snapshot.components.find((c) => c.componentId === 'route-serial');
    assert.equal(rs.activationCounts['inline_action.checked'], 19);
    assert.equal(rs.activationCounts['line_start.detected'], 5);
    assert.notEqual(rs.confidence, 'no-data');
  });

  it('counts hold_ball from trace events', () => {
    const now = Date.now();
    const holdBallSpan = {
      traceId: 'abc',
      spanId: '123',
      name: 'cat_cafe.tool_use mcp__cat-cafe__cat_cafe_hold_ball',
      startTimeMs: now - 1000,
      endTimeMs: now,
      durationMs: 1000,
      status: { code: 0 },
      attributes: { 'tool.name': 'mcp__cat-cafe__cat_cafe_hold_ball' },
      events: [],
    };
    const snapshot = generateF167Snapshot({
      traces: { spans: [holdBallSpan], count: 1 },
      metrics: {},
      metricsHistory: { snapshots: [], count: 0 },
      traceStats: {
        spanCount: 1,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: now,
        newestStoredAt: now,
      },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.equal(c1.activationCounts['hold_ball_calls'], 1);
  });

  it('counts multiple hold_ball events across spans', () => {
    const now = Date.now();
    const makeSpan = (id, toolName) => ({
      traceId: 'abc',
      spanId: id,
      name: `cat_cafe.tool_use ${toolName}`,
      startTimeMs: now - 1000,
      endTimeMs: now,
      durationMs: 1000,
      status: { code: 0 },
      attributes: { 'tool.name': toolName },
      events: [],
    });
    const snapshot = generateF167Snapshot({
      traces: {
        spans: [
          makeSpan('s1', 'mcp__cat-cafe__cat_cafe_hold_ball'),
          makeSpan('s2', 'mcp__cat-cafe__cat_cafe_hold_ball'),
          makeSpan('s3', 'mcp__cat-cafe__cat_cafe_post_message'),
        ],
        count: 3,
      },
      metrics: {},
      metricsHistory: { snapshots: [], count: 0 },
      traceStats: {
        spanCount: 3,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: now,
        newestStoredAt: now,
      },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.equal(c1.activationCounts['hold_ball_calls'], 2);
  });

  it('does not count tools with similar suffix as hold_ball', () => {
    const now = Date.now();
    const snapshot = generateF167Snapshot({
      traces: {
        spans: [
          {
            traceId: 'abc',
            spanId: 'neg1',
            name: 'cat_cafe.tool_use mcp__fake__not_cat_cafe_hold_ball',
            startTimeMs: now - 1000,
            endTimeMs: now,
            durationMs: 1000,
            status: { code: 0 },
            attributes: { 'tool.name': 'mcp__fake__not_cat_cafe_hold_ball' },
            events: [],
          },
        ],
        count: 1,
      },
      metrics: {},
      metricsHistory: { snapshots: [], count: 0 },
      traceStats: { spanCount: 1, maxSpans: 10000, maxAgeMs: 86400000, oldestStoredAt: now, newestStoredAt: now },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.equal(c1.activationCounts['hold_ball_calls'], 0);
  });

  it('L1/C1/C2 report no gaps when counters exist at zero (warmup)', () => {
    const snapshot = generateF167Snapshot({
      traces: { spans: [], count: 0 },
      metrics: {
        cat_cafe_a2a_l1_streak_warn_count: 0,
        cat_cafe_a2a_l1_streak_break_count: 0,
        cat_cafe_a2a_c1_zombie_hold_count: 0,
        cat_cafe_a2a_c1_hold_cancel_count: 0,
        cat_cafe_a2a_c2_verdict_hint_emitted: 0,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 0,
        cat_cafe_a2a_c2_verdict_without_pass_count: 0,
      },
      metricsHistory: { snapshots: [], count: 0 },
      traceStats: { spanCount: 0, maxSpans: 10000, maxAgeMs: 86400000, oldestStoredAt: null, newestStoredAt: null },
    });
    for (const comp of snapshot.components) {
      assert.deepStrictEqual(
        comp.telemetryGaps,
        [],
        `${comp.componentId} should have no gaps with zero-value counters`,
      );
    }
  });

  it('overall confidence reflects worst component', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.overallConfidence, 'no-data');
  });

  it('includes summary string', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(typeof snapshot.summary, 'string');
    assert.ok(snapshot.summary.length > 0);
  });

  it('extracts L1 streak counters and upgrades confidence (AC-D0)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_l1_streak_warn_count: 5,
        cat_cafe_a2a_l1_streak_break_count: 1,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const l1 = snapshot.components.find((c) => c.componentId === 'L1');
    assert.equal(l1.activationCounts['l1.streak_warn_count'], 5);
    assert.equal(l1.activationCounts['l1.streak_break_count'], 1);
    assert.notEqual(l1.confidence, 'no-data');
    assert.equal(l1.telemetryGaps.length, 0);
  });

  it('extracts C1 zombie/cancel counters and upgrades confidence (AC-D0)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c1_zombie_hold_count: 2,
        cat_cafe_a2a_c1_hold_cancel_count: 3,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.equal(c1.frictionCounts['c1.zombie_hold_count'], 2);
    assert.equal(c1.frictionCounts['c1.hold_cancel_count'], 3);
    assert.notEqual(c1.confidence, 'no-data');
    assert.equal(c1.telemetryGaps.length, 0);
  });

  it('extracts C2 split hint counters and classifies friction correctly (AC-D0)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c2_verdict_hint_emitted: 4,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 1,
        cat_cafe_a2a_c2_verdict_without_pass_count: 3,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    // verdict_hint_emitted is activation (guard fired)
    assert.equal(c2.activationCounts['c2.verdict_hint_emitted'], 4);
    // verdict_without_pass and void_hold are friction (violations)
    assert.equal(c2.frictionCounts['c2.verdict_without_pass_count'], 3);
    assert.equal(c2.frictionCounts['c2.void_hold_hint_emitted'], 1);
    assert.notEqual(c2.confidence, 'no-data');
    assert.ok(c2.telemetryGaps.length === 0 || !c2.telemetryGaps.some((g) => g.reason === 'no_counter'));
  });

  it('C2 friction signals populate frictionCounts (Day-9 regression)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c2_verdict_hint_emitted: 13,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 4,
        cat_cafe_a2a_c2_verdict_without_pass_count: 13,
      },
      traceStats: {
        spanCount: 100,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    // Must have non-empty frictionCounts so attribution can generate findings
    assert.ok(Object.keys(c2.frictionCounts).length > 0, 'C2 must have friction counts');
    assert.ok(c2.frictionCounts['c2.verdict_without_pass_count'] >= 3, 'verdict_without_pass must be friction');
    assert.ok(c2.frictionCounts['c2.void_hold_hint_emitted'] >= 3, 'void_hold must be friction');
  });

  it('exposes both C2 denominators (c2.checked + c2.void_hold_checked) from counters (PR #1941)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c2_verdict_hint_emitted: 9,
        cat_cafe_a2a_c2_verdict_without_pass_count: 9,
        cat_cafe_a2a_c2_exit_checked: 200,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 4,
        cat_cafe_a2a_c2_void_hold_checked: 25,
      },
      traceStats: {
        spanCount: 100,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    // Two distinct denominators so attribution grades each friction against the right base.
    assert.equal(c2.activationCounts['c2.checked'], 200);
    assert.equal(c2.activationCounts['c2.void_hold_checked'], 25);
    assert.equal(c2.frictionCounts['c2.verdict_without_pass_count'], 9);
    assert.equal(c2.frictionCounts['c2.void_hold_hint_emitted'], 4);
  });

  it('C2 frictionSamples populated from span events (F192 Phase D per-fire evidence)', () => {
    const baseSpan = {
      traceId: 'trace-1',
      spanId: 's-x',
      name: 'cat_cafe.route',
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: { code: 0 },
      attributes: {},
      events: [],
    };
    const spans = [
      {
        ...baseSpan,
        spanId: 's-a',
        events: [
          {
            name: 'c2.verdict_without_pass_fired',
            timeMs: 1000,
            attributes: {
              messageId: 'hash-msg-a',
              invocationId: 'hash-inv-a',
              threadId: 'hash-thread-a',
              'agent.id': 'codex',
              'thread.system_kind': 'product',
              trigger: 'reject',
            },
          },
        ],
      },
      {
        ...baseSpan,
        spanId: 's-b',
        events: [
          {
            name: 'c2.verdict_without_pass_fired',
            timeMs: 2000,
            attributes: {
              messageId: 'hash-msg-b',
              invocationId: 'hash-inv-b',
              threadId: 'hash-thread-b',
              'agent.id': 'opus',
              'thread.system_kind': 'product',
              trigger: 'p1p2',
            },
          },
        ],
      },
    ];

    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: 2 },
      metrics: { cat_cafe_a2a_c2_verdict_without_pass_count: 2, cat_cafe_a2a_c2_exit_checked: 17 },
      traceStats: {
        spanCount: 2,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    const samples = c2.frictionSamples['c2.verdict_without_pass_count'];
    assert.ok(Array.isArray(samples) && samples.length === 2, 'frictionSamples must surface both fires');
    // firedAt desc: 2000 > 1000
    assert.equal(samples[0].spanId, 's-b');
    assert.equal(samples[0].trigger, 'p1p2');
    assert.equal(samples[0].agentId, 'opus');
    assert.equal(samples[0].messageIdHash, 'hash-msg-b');
    assert.equal(samples[1].spanId, 's-a');
    assert.equal(samples[1].trigger, 'reject');
    // Sister buckets stay empty
    assert.deepEqual(snapshot.components.find((c) => c.componentId === 'L1').frictionSamples, {});
    assert.deepEqual(snapshot.components.find((c) => c.componentId === 'C1').frictionSamples, {});
    assert.deepEqual(snapshot.components.find((c) => c.componentId === 'route-serial').frictionSamples, {});
  });

  it('C2 frictionSamples empty when spans have no matching events (data-driven, no fabrication)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: { cat_cafe_a2a_c2_verdict_without_pass_count: 3, cat_cafe_a2a_c2_exit_checked: 17 },
    });
    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    // Counters say 3 fires happened, but no span events emitted them →
    // frictionSamples empty (attribution will mark sampleCoverage.complete=false later).
    assert.deepEqual(c2.frictionSamples, {});
  });

  it('C2 frictionSamples surfaces void-hold per-fire samples under c2.void_hold_hint_emitted (F192 D — 2026-06-10 build verdict)', () => {
    const baseSpan = {
      traceId: 'trace-vh',
      spanId: 's-x',
      name: 'cat_cafe.route',
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: { code: 0 },
      attributes: {},
      events: [],
    };
    const spans = [
      {
        ...baseSpan,
        spanId: 's-vh-a',
        events: [
          {
            name: 'c2.void_hold_fired',
            timeMs: 1000,
            attributes: {
              messageId: 'hash-msg-vh-a',
              invocationId: 'hash-inv-vh-a',
              threadId: 'hash-thread-vh-a',
              'agent.id': 'opus-47',
              'thread.system_kind': 'product',
              trigger: 'cn_chiqiu',
            },
          },
        ],
      },
      {
        ...baseSpan,
        spanId: 's-vh-b',
        events: [
          {
            name: 'c2.void_hold_fired',
            timeMs: 2000,
            attributes: {
              messageId: 'hash-msg-vh-b',
              invocationId: 'hash-inv-vh-b',
              threadId: 'hash-thread-vh-b',
              'agent.id': 'opus-47',
              'thread.system_kind': 'product',
              trigger: 'mcp_tool_name',
            },
          },
        ],
      },
    ];

    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: 2 },
      metrics: {
        cat_cafe_a2a_c2_void_hold_hint_emitted: 2,
        cat_cafe_a2a_c2_void_hold_checked: 25,
      },
      traceStats: {
        spanCount: 2,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    const samples = c2.frictionSamples['c2.void_hold_hint_emitted'];
    assert.ok(Array.isArray(samples) && samples.length === 2, 'void_hold frictionSamples must surface both fires');
    // firedAt desc: 2000 > 1000
    assert.equal(samples[0].spanId, 's-vh-b');
    assert.equal(samples[0].trigger, 'mcp_tool_name');
    assert.equal(samples[0].messageIdHash, 'hash-msg-vh-b');
    assert.equal(samples[1].spanId, 's-vh-a');
    assert.equal(samples[1].trigger, 'cn_chiqiu');
  });

  it('C2 frictionSamples: void-hold and verdict-without-pass samples surface independently on same finding', () => {
    const baseSpan = {
      traceId: 'trace-mix',
      spanId: 's-x',
      name: 'cat_cafe.route',
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: { code: 0 },
      attributes: {},
      events: [],
    };
    const spans = [
      {
        ...baseSpan,
        spanId: 's-v',
        events: [
          {
            name: 'c2.verdict_without_pass_fired',
            timeMs: 1500,
            attributes: {
              messageId: 'hash-msg-v',
              invocationId: 'hash-inv-v',
              threadId: 'hash-thread-v',
              'agent.id': 'codex',
              'thread.system_kind': 'product',
              trigger: 'p1p2',
            },
          },
        ],
      },
      {
        ...baseSpan,
        spanId: 's-vh',
        events: [
          {
            name: 'c2.void_hold_fired',
            timeMs: 1500,
            attributes: {
              messageId: 'hash-msg-vh',
              invocationId: 'hash-inv-vh',
              threadId: 'hash-thread-vh',
              'agent.id': 'opus-47',
              'thread.system_kind': 'product',
              trigger: 'cn_wo_chi_qiu',
            },
          },
        ],
      },
    ];

    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: 2 },
      metrics: {
        cat_cafe_a2a_c2_verdict_without_pass_count: 1,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 1,
        cat_cafe_a2a_c2_exit_checked: 17,
        cat_cafe_a2a_c2_void_hold_checked: 25,
      },
      traceStats: {
        spanCount: 2,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const c2 = snapshot.components.find((c) => c.componentId === 'C2');
    assert.equal(c2.frictionSamples['c2.verdict_without_pass_count']?.length, 1);
    assert.equal(c2.frictionSamples['c2.void_hold_hint_emitted']?.length, 1);
    // No cross-contamination: each bucket holds only its own event type
    assert.equal(c2.frictionSamples['c2.verdict_without_pass_count'][0].trigger, 'p1p2');
    assert.equal(c2.frictionSamples['c2.void_hold_hint_emitted'][0].trigger, 'cn_wo_chi_qiu');
  });
});

describe('F192 D — C1 zombie-hold per-fire sample evidence (eval:a2a 2026-06-12 build verdict)', () => {
  const emptyInput = {
    metrics: {},
    traces: { spans: [], count: 0 },
    metricsHistory: { snapshots: [], count: 0 },
    traceStats: { spanCount: 0, maxSpans: 10000, maxAgeMs: 86400000, oldestStoredAt: null, newestStoredAt: null },
  };

  it('C1 frictionSamples surfaces zombie-hold per-fire samples under c1.zombie_hold_count', () => {
    const baseSpan = {
      traceId: 'trace-c1',
      spanId: 's-x',
      name: 'cat_cafe.a2a.c1.zombie_hold_sample',
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: { code: 0 },
      attributes: {},
      events: [],
    };
    const spans = [
      {
        ...baseSpan,
        spanId: 's-zh-a',
        events: [
          {
            name: 'c1.zombie_hold_fired',
            timeMs: 1000,
            attributes: {
              messageId: 'hash-prior-a',
              invocationId: 'hash-inv-a',
              threadId: 'hash-thread-a',
              'agent.id': 'opus-47',
              'thread.system_kind': 'product',
              trigger: 'prior_imminent',
              priorTaskIdHash: 'hash-prior-a',
              newTaskIdHash: 'hash-new-a',
            },
          },
        ],
      },
      {
        ...baseSpan,
        spanId: 's-zh-b',
        events: [
          {
            name: 'c1.zombie_hold_fired',
            timeMs: 2000,
            attributes: {
              messageId: 'hash-prior-b',
              invocationId: 'hash-inv-b',
              threadId: 'hash-thread-b',
              'agent.id': 'opus-47',
              'thread.system_kind': 'product',
              trigger: 'prior_long',
              priorTaskIdHash: 'hash-prior-b',
              newTaskIdHash: 'hash-new-b',
            },
          },
        ],
      },
    ];

    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: 2 },
      metrics: { cat_cafe_a2a_c1_zombie_hold_count: 2 },
      traceStats: {
        spanCount: 2,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    const samples = c1.frictionSamples['c1.zombie_hold_count'];
    assert.ok(Array.isArray(samples) && samples.length === 2, 'C1 frictionSamples must surface both fires');
    // firedAt desc: 2000 > 1000
    assert.equal(samples[0].spanId, 's-zh-b');
    assert.equal(samples[0].trigger, 'prior_long');
    assert.equal(samples[1].trigger, 'prior_imminent');
    // R1 P1-1 (砚砚): priorTaskIdHash + newTaskIdHash must survive the buildC1 path
    // — generic extractor was previously dropping them, so attribution YAML lost
    // the verdict-requested extras. Asserting both samples here locks the regression.
    assert.ok(samples[0].extras, 'extras must be present on C1 samples that emitted both hashes');
    assert.equal(samples[0].extras.priorTaskIdHash, 'hash-prior-b');
    assert.equal(samples[0].extras.newTaskIdHash, 'hash-new-b');
    assert.equal(samples[1].extras.priorTaskIdHash, 'hash-prior-a');
    assert.equal(samples[1].extras.newTaskIdHash, 'hash-new-a');
  });

  it('C1 frictionSamples empty when no zombie-hold events in spans (data-driven, no fabrication)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: { cat_cafe_a2a_c1_zombie_hold_count: 3 },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.deepEqual(c1.frictionSamples, {});
  });

  it('C1 frictionSamples isolation — C2 verdict/void-hold events do NOT bleed into C1 bucket', () => {
    const baseSpan = {
      traceId: 'trace-mix',
      spanId: 's-x',
      name: 'cat_cafe.route',
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: { code: 0 },
      attributes: {},
      events: [],
    };
    const spans = [
      {
        ...baseSpan,
        spanId: 's-v',
        events: [
          {
            name: 'c2.verdict_without_pass_fired',
            timeMs: 1500,
            attributes: {
              messageId: 'hash-msg-v',
              invocationId: 'hash-inv-v',
              threadId: 'hash-thread-v',
              'agent.id': 'codex',
              'thread.system_kind': 'product',
              trigger: 'p1p2',
            },
          },
        ],
      },
    ];
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: 1 },
      metrics: {
        cat_cafe_a2a_c2_verdict_without_pass_count: 1,
        cat_cafe_a2a_c2_exit_checked: 17,
      },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.deepEqual(c1.frictionSamples, {}, 'C2 events must not surface under C1.frictionSamples');
  });
});
