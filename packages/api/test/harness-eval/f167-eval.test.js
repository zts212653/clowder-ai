import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
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
  it('produces snapshot with 5 components (incl. Phase O grounding)', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.featureId, 'F167');
    assert.equal(snapshot.components.length, 5);
    const ids = snapshot.components.map((c) => c.componentId).sort();
    assert.deepEqual(ids, ['C1', 'C2', 'L1', 'grounding-phase-o', 'route-serial']);
  });

  it('includes metadata fields', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.dataSource, 'F153 /api/telemetry/*');
    assert.equal(snapshot.generatedBy, 'F192 Phase C eval');
    assert.ok(snapshot.generatedAt);
    assert.ok(snapshot.window);
    assert.equal(typeof snapshot.window.durationHours, 'number');
  });

  // ── F167 sibling-PR (telemetry counter baseline persistence) ──
  //
  // Silent false positive scenario: hydrated traceStore covers 24h, but OTel
  // counters are process-lifetime cumulative since process boot. Eval consumers
  // that compute rate = counter / window.durationHours get a low denominator
  // mismatch when process_uptime << trace_window. Fix: snapshot exposes a
  // separate counterWindow whose startMs reflects process boot, so eval cats
  // pick the right denominator for counter rate. Trace window stays unchanged
  // for trace-based density math.
  describe('counterWindow (process-lifetime baseline awareness)', () => {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;

    it('omits counterWindow when processStartMs is not provided (backward compat)', () => {
      const snapshot = generateF167Snapshot(emptyInput);
      assert.equal(snapshot.counterWindow, undefined);
    });

    it('exposes counterWindow when processStartMs is provided', () => {
      // Anchor to wall clock — generateF167Snapshot calls Date.now() internally,
      // so processStartMs must be relative to "now", not a fixed epoch constant.
      const processStartMs = Date.now() - ONE_HOUR_MS;
      const snapshot = generateF167Snapshot({
        ...emptyInput,
        processStartMs,
      });
      assert.ok(snapshot.counterWindow, 'counterWindow must be present');
      assert.equal(snapshot.counterWindow.startMs, processStartMs);
      assert.ok(typeof snapshot.counterWindow.endMs === 'number');
      assert.ok(snapshot.counterWindow.endMs >= processStartMs);
      assert.ok(typeof snapshot.counterWindow.durationHours === 'number');
      // Sanity: a 1h-old process gives ~1h counterWindow, not 24h
      assert.ok(
        snapshot.counterWindow.durationHours >= 0.9 && snapshot.counterWindow.durationHours <= 1.5,
        `Expected ~1h counterWindow, got ${snapshot.counterWindow.durationHours}h`,
      );
    });

    // F167 sibling-PR review fix (P2 gpt52): when server exposes uptimeSec
    // (monotonic, NTP-safe), eval should use it as the duration source of
    // truth — not compute `local Date.now() - remote processStartMs`, which
    // assumes runner and API share a clock.

    it('prefers processUptimeSec over local-clock arithmetic when provided (P2 fix)', () => {
      // Construct a stale processStartMs that would yield a wildly wrong
      // duration under local-clock arithmetic (e.g. NTP drift / cross-host
      // runner). uptimeSec is the authoritative source.
      const staleProcessStartMs = Date.now() - 99 * 60 * 60 * 1000; // 99h ago (wrong if clocks drifted)
      const authoritativeUptimeSec = 3600; // server says: actually 1h
      const snapshot = generateF167Snapshot({
        ...emptyInput,
        processStartMs: staleProcessStartMs,
        processUptimeSec: authoritativeUptimeSec,
      });
      assert.ok(snapshot.counterWindow);
      // durationHours must come from uptimeSec, not from local Date.now() - processStartMs
      assert.equal(snapshot.counterWindow.durationHours, 1, 'must use uptimeSec/3600, not local-clock subtraction');
      // endMs - startMs must be exactly uptimeSec * 1000 (server-coherent)
      assert.equal(
        snapshot.counterWindow.endMs - snapshot.counterWindow.startMs,
        authoritativeUptimeSec * 1000,
        'startMs/endMs must be server-coherent (derived from uptimeSec, not mixed clocks)',
      );
    });

    it('rounds counter_window endMs to integer for fractional uptimeSec (R2 cloud P1)', () => {
      // process.uptime() returns fractional seconds. uptimeSec * 1000 can be
      // fractional ms, but bundleSnapshotSchema requires startMs/endMs to be
      // integer (z.number().int()). Without Math.round, a normal restart-
      // recent eval would serialize, pass formatter, then get rejected by
      // resolveA2aEvidenceBundle when the bundle is later consumed.
      const processStartMs = 1_700_000_000_000; // integer
      const fractionalUptimeSec = 3600.1234567; // fractional → 3600123.4567 fractional ms
      const snapshot = generateF167Snapshot({
        ...emptyInput,
        processStartMs,
        processUptimeSec: fractionalUptimeSec,
      });
      assert.ok(snapshot.counterWindow);
      assert.ok(
        Number.isInteger(snapshot.counterWindow.startMs),
        `startMs must be integer, got ${snapshot.counterWindow.startMs}`,
      );
      assert.ok(
        Number.isInteger(snapshot.counterWindow.endMs),
        `endMs must be integer (bundleSnapshotSchema requires z.number().int()), got ${snapshot.counterWindow.endMs}`,
      );
    });

    it('falls back to processStartMs-only mode when uptimeSec absent (backward compat)', () => {
      const processStartMs = Date.now() - ONE_HOUR_MS;
      const snapshot = generateF167Snapshot({
        ...emptyInput,
        processStartMs,
        // No processUptimeSec — legacy path
      });
      assert.ok(snapshot.counterWindow);
      // Old behavior preserved: ~1h durationHours derived from local clock
      assert.ok(
        snapshot.counterWindow.durationHours >= 0.9 && snapshot.counterWindow.durationHours <= 1.5,
        `Legacy mode should still derive ~1h, got ${snapshot.counterWindow.durationHours}h`,
      );
    });

    it('counterWindow is independent from trace window (silent false positive fix)', () => {
      // Worst case: traceStore was hydrated 24h back, but process only booted 1h ago.
      // Pre-fix: window.durationHours == 24, counter.durationHours implicit 24 → rate underreports.
      // Post-fix: snapshot exposes both windows, eval picks counterWindow for counter rate.
      const now = Date.now();
      const processStartMs = now - ONE_HOUR_MS;
      const traceOldest = now - TWENTY_FOUR_HOURS_MS;
      const snapshot = generateF167Snapshot({
        ...emptyInput,
        processStartMs,
        traceStats: {
          ...emptyInput.traceStats,
          oldestStoredAt: traceOldest,
          newestStoredAt: now,
        },
      });
      // Trace window reflects hydrated 24h history (unchanged semantics)
      assert.ok(
        snapshot.window.durationHours >= 23 && snapshot.window.durationHours <= 25,
        `Expected ~24h trace window, got ${snapshot.window.durationHours}h`,
      );
      // Counter window reflects process lifetime (~1h)
      assert.ok(snapshot.counterWindow);
      assert.ok(
        snapshot.counterWindow.durationHours >= 0.9 && snapshot.counterWindow.durationHours <= 1.5,
        `Expected ~1h counterWindow even when trace window is 24h, got ${snapshot.counterWindow.durationHours}h`,
      );
      // Critical invariant: counterWindow.startMs must NOT equal trace.startMs
      // (would mean baseline awareness is missing and rate denominator is wrong)
      assert.notEqual(snapshot.counterWindow.startMs, snapshot.window.startMs);
    });
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
        cat_cafe_a2a_c1_hold_zombie_count: 0,
        cat_cafe_a2a_c1_hold_replacement_count: 0,
        cat_cafe_a2a_c1_hold_cancel_count: 0,
        cat_cafe_a2a_c2_verdict_hint_emitted: 0,
        cat_cafe_a2a_c2_void_hold_hint_emitted: 0,
        cat_cafe_a2a_c2_verdict_without_pass_count: 0,
        // F167 Phase O: grounding shadow counters
        cat_cafe_a2a_grounding_check_total: 0,
        cat_cafe_a2a_grounding_verdict_total: 0,
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

  it('routes C1 zombie/replacement/cancel counters to activation vs friction (verdict 2026-06-18 + R1 P1 #1)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c1_hold_zombie_count: 1,
        cat_cafe_a2a_c1_hold_replacement_count: 5,
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
    // Friction: only actionable buckets (zombie + cancel)
    assert.equal(c1.frictionCounts['c1.hold_zombie_count'], 1);
    assert.equal(c1.frictionCounts['c1.hold_cancel_count'], 3);
    assert.equal(c1.frictionCounts['c1.hold_replacement_count'], undefined, 'replacement must NOT route to friction');
    // Activation: replacement throughput (砚砚 R1 P1 #1 — generic friction grading
    // would re-create the 06-18 false positive under the renamed metric)
    assert.equal(c1.activationCounts['c1.hold_replacement_count'], 5);
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

describe('F192 D — C1 hold per-fire sample evidence (verdict 2026-06-18 zombie/replacement split)', () => {
  const emptyInput = {
    metrics: {},
    traces: { spans: [], count: 0 },
    metricsHistory: { snapshots: [], count: 0 },
    traceStats: { spanCount: 0, maxSpans: 10000, maxAgeMs: 86400000, oldestStoredAt: null, newestStoredAt: null },
  };

  it('C1 frictionSamples surfaces hold_zombie only (replacement is activation, never enters frictionSamples per R1 P1 #1)', () => {
    const baseSpan = {
      traceId: 'trace-c1',
      spanId: 's-x',
      name: 'cat_cafe.a2a.c1.hold_zombie_sample',
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
        name: 'cat_cafe.a2a.c1.hold_zombie_sample',
        events: [
          {
            name: 'c1.hold_zombie_fired',
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
        name: 'cat_cafe.a2a.c1.hold_replacement_sample',
        events: [
          {
            name: 'c1.hold_replacement_fired',
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
      metrics: {
        cat_cafe_a2a_c1_hold_zombie_count: 1,
        cat_cafe_a2a_c1_hold_replacement_count: 1,
      },
      traceStats: {
        spanCount: 2,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    const zombieSamples = c1.frictionSamples['c1.hold_zombie_count'];
    assert.ok(Array.isArray(zombieSamples) && zombieSamples.length === 1, 'zombie samples present');
    assert.equal(zombieSamples[0].trigger, 'prior_imminent');
    assert.ok(zombieSamples[0].extras, 'extras must be present on zombie samples');
    assert.equal(zombieSamples[0].extras.priorTaskIdHash, 'hash-prior-a');
    assert.equal(zombieSamples[0].extras.newTaskIdHash, 'hash-new-a');
    // 砚砚 R1 P1 #1: replacement is activation, not friction — no frictionSamples entry.
    assert.equal(
      c1.frictionSamples['c1.hold_replacement_count'],
      undefined,
      'replacement samples must NOT surface under frictionSamples (would re-create 06-18 false positive)',
    );
  });

  it('砚砚 R1 P1 #1 regression: replacement-only 4/6 must NOT become a high actionable finding', async () => {
    // 06-18 verdict shape: hold_zombie=0, hold_replacement=4, hold_ball_calls=6 (66.7%).
    // Pre-split: `c1.zombie_hold_count` would grade severity=high / human-required.
    // Post-split fix: replacement routes to activation, never reaches the friction
    // grading pipeline, so attribution emits zero replacement-driven findings.
    const { generateAttributionReport } = await import('../../dist/infrastructure/harness-eval/attribution.js');
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: {
        spans: Array(6)
          .fill({})
          .map((_, i) => ({
            traceId: `t-${i}`,
            spanId: `s-${i}`,
            name: 'cat_cafe.tool.invoke',
            startTimeMs: 0,
            endTimeMs: 0,
            durationMs: 0,
            status: { code: 0 },
            attributes: { 'tool.name': 'cat_cafe_hold_ball' },
            events: [],
          })),
        count: 6,
      },
      metrics: {
        cat_cafe_a2a_c1_hold_zombie_count: 0,
        cat_cafe_a2a_c1_hold_replacement_count: 4,
      },
      traceStats: { spanCount: 6, maxSpans: 10000, maxAgeMs: 86400000, oldestStoredAt: 0, newestStoredAt: 0 },
    });
    const c1 = snapshot.components.find((c) => c.componentId === 'C1');
    assert.equal(c1.activationCounts['hold_ball_calls'], 6);
    assert.equal(c1.activationCounts['c1.hold_replacement_count'], 4);
    assert.equal(c1.frictionCounts['c1.hold_replacement_count'], undefined);

    const report = generateAttributionReport({ featureId: 'F167', snapshot });
    const replacementFindings = report.findings.filter((f) => f.frictionSignal.type === 'c1.hold_replacement_count');
    assert.equal(
      replacementFindings.length,
      0,
      `replacement-only 4/6 must yield ZERO findings on c1.hold_replacement_count; got: ${JSON.stringify(replacementFindings, null, 2)}`,
    );
  });

  it('C1 frictionSamples empty when no C1 events in spans (data-driven, no fabrication)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_c1_hold_zombie_count: 3,
        cat_cafe_a2a_c1_hold_replacement_count: 5,
      },
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

  // ── Cloud R2 P2 regressions ────────────────────────────────────

  it('Cloud P2-3: cache_hit_total is activation, not friction (no false positive)', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_grounding_check_total: 50,
        cat_cafe_a2a_grounding_verdict_total: 50,
        cat_cafe_a2a_grounding_cache_hit_total: 30,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const g = snapshot.components.find((c) => c.componentId === 'grounding-phase-o');
    // cache_hit_total must be in activationCounts, NOT frictionCounts
    assert.equal(g.activationCounts['grounding.cache_hit_total'], 30);
    assert.equal(g.frictionCounts['grounding.cache_hit_total'], undefined);

    // Attribution must not produce a finding for cache hits
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: { components: [g] },
    });
    assert.equal(report.findings.length, 0, 'healthy cache hits must not trigger findings');
  });

  it('PR-O2b: groundingSampleEvidence surfaces mismatch/insufficient in snapshot', () => {
    const now = Date.now();
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_grounding_check_total: 100,
        cat_cafe_a2a_grounding_verdict_total: 100,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: now - 3600000,
        newestStoredAt: now,
      },
      groundingSamples: [
        {
          invocationId: 'inv-1',
          catId: 'opus',
          threadId: 'thread-1',
          claimType: 'object',
          sourceKind: 'self',
          sourceRef: { kind: 'pr_url', value: 'org/repo#1' },
          resolver: 'github_pr',
          resolverSourceTier: 'T1',
          cacheHit: false,
          verdict: 'mismatch',
          verdictReason: 'pr_not_found',
          actionFamily: 'register_tracking',
          actionRisk: 'register_tracking',
          tool: 'register_pr_tracking',
          ts: now - 1000,
          resolverCallsRemaining: 5,
        },
        {
          invocationId: 'inv-2',
          catId: 'sonnet',
          threadId: 'thread-2',
          claimType: 'wait',
          sourceKind: 'self',
          sourceRef: { kind: 'messageId', value: '' },
          resolver: 'none',
          resolverSourceTier: 'T2',
          cacheHit: false,
          verdict: 'insufficient',
          verdictReason: 'no_applicable_resolver',
          actionFamily: 'wait',
          actionRisk: 'hold_ball',
          tool: 'hold_ball',
          ts: now - 500,
          resolverCallsRemaining: 10,
        },
        {
          invocationId: 'inv-3',
          catId: 'opus',
          threadId: 'thread-1',
          claimType: 'object',
          sourceKind: 'self',
          sourceRef: { kind: 'issue_id', value: 'org/repo#42' },
          resolver: 'github_issue',
          resolverSourceTier: 'T1',
          cacheHit: false,
          verdict: 'verified',
          actionFamily: 'register_tracking',
          actionRisk: 'register_tracking',
          tool: 'register_issue_tracking',
          ts: now - 200,
          resolverCallsRemaining: 8,
        },
      ],
    });

    // Top-level sample evidence present
    assert.ok(snapshot.groundingSampleEvidence);
    assert.equal(snapshot.groundingSampleEvidence.totalSampled, 3);
    assert.equal(snapshot.groundingSampleEvidence.byVerdict.mismatch, 1);
    assert.equal(snapshot.groundingSampleEvidence.byVerdict.insufficient, 1);
    assert.equal(snapshot.groundingSampleEvidence.byVerdict.verified, 1);
    assert.equal(snapshot.groundingSampleEvidence.byTool.register_pr_tracking, 1);
    assert.equal(snapshot.groundingSampleEvidence.byTool.hold_ball, 1);
    assert.equal(snapshot.groundingSampleEvidence.byTool.register_issue_tracking, 1);

    // recentActionable contains only mismatch + insufficient (not verified)
    assert.equal(snapshot.groundingSampleEvidence.recentActionable.length, 2);
    assert.ok(
      snapshot.groundingSampleEvidence.recentActionable.every(
        (e) => e.verdict === 'mismatch' || e.verdict === 'insufficient',
      ),
    );

    // Component-level activation counts include sample count
    const g = snapshot.components.find((c) => c.componentId === 'grounding-phase-o');
    assert.equal(g.activationCounts['grounding.sample_count'], 3);
    assert.equal(g.activationCounts['grounding.mismatch_sample_count'], 1);
  });

  it('PR-O2b: groundingSampleEvidence undefined when no samples', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_grounding_check_total: 10,
        cat_cafe_a2a_grounding_verdict_total: 10,
      },
      traceStats: {
        spanCount: 1,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
      groundingSamples: [],
    });
    assert.equal(snapshot.groundingSampleEvidence, undefined);
  });

  it('Cloud P2-4: budget_exhausted denominator resolves to grounding.check_total', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_grounding_check_total: 50,
        cat_cafe_a2a_grounding_verdict_total: 50,
        cat_cafe_a2a_grounding_budget_exhausted_total: 5,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });
    const g = snapshot.components.find((c) => c.componentId === 'grounding-phase-o');
    assert.equal(g.frictionCounts['grounding.budget_exhausted_total'], 5);

    // Attribution must produce a finding WITH a real denominator
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: { components: [g] },
    });
    assert.ok(report.findings.length >= 1, 'budget exhaustion should produce a finding');
    const finding = report.findings[0];
    // Must reference the real denominator, not 'grounding.checked' (missing)
    assert.ok(
      finding.attribution.evidence.some((e) => e.excerpt.includes('grounding.check_total=50')),
      'finding should reference grounding.check_total as denominator, not grounding.checked',
    );
  });
});
