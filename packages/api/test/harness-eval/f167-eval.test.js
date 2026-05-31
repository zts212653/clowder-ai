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
});
