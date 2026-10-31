/**
 * F236 Phase A/B-Eval Track-1 — anchor telemetry OTel emit.
 *
 * The 4 anchor-first callback sites (pending-mentions / thread-context /
 * list-tasks previews + get-message full-drill) used to emit ONLY
 * `app.log.info` (ephemeral stdout, lost in ~24h, no queryable consumer).
 * Track-1 funnels them through a central recorder that ALSO emits OTel
 * metrics (counter + histogram) so the anchor chars + request/response volume
 * become a queryable substrate.
 *
 * Mirrors the callback-auth-telemetry recorder pattern: the OTel counter
 * shape lives in instruments.ts (bound to the metric allowlist); this file
 * proves the in-memory tally that the recorder maintains alongside the OTel
 * `.add()/.record()` fire-and-forget calls. (Same convention as
 * callback-auth-telemetry.test.js — assert the recorder snapshot, not the
 * exporter, since this repo has no in-unit OTel exporter readout harness.)
 *
 * Chars + volume substrate contract (砚砚 eval-owner ruling iii): the recorder
 * records returnedChars / fullDrillChars (the 省/savings signal) and per-tool
 * request/response volume counts. It MUST NOT compute a per-tool drill↔preview
 * open-rate — that needs a correlated event model and is Track-2's scope.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('anchor-telemetry (F236 Track-1)', () => {
  let recordAnchorReturned;
  let recordAnchorFullDrill;
  let getAnchorTelemetrySnapshot;
  let resetAnchorTelemetryForTest;

  beforeEach(async () => {
    const mod = await import('../dist/routes/anchor-telemetry.js');
    recordAnchorReturned = mod.recordAnchorReturned;
    recordAnchorFullDrill = mod.recordAnchorFullDrill;
    getAnchorTelemetrySnapshot = mod.getAnchorTelemetrySnapshot;
    resetAnchorTelemetryForTest = mod.resetAnchorTelemetryForTest;
    resetAnchorTelemetryForTest();
  });

  test('snapshot starts empty', () => {
    const snap = getAnchorTelemetrySnapshot();
    assert.deepEqual(snap.returnedByTool, {});
    assert.deepEqual(snap.returnedCharsByTool, {});
    assert.deepEqual(snap.drillByTool, {});
    assert.deepEqual(snap.drillCharsByTool, {});
  });

  test('recordAnchorReturned tallies occurrences per tool', () => {
    recordAnchorReturned({ tool: 'pending-mentions', returnedChars: 100 });
    recordAnchorReturned({ tool: 'pending-mentions', returnedChars: 50 });
    recordAnchorReturned({ tool: 'thread-context', returnedChars: 200 });
    recordAnchorReturned({ tool: 'list-tasks', returnedChars: 30 });
    const snap = getAnchorTelemetrySnapshot();
    assert.equal(snap.returnedByTool['pending-mentions'], 2);
    assert.equal(snap.returnedByTool['thread-context'], 1);
    assert.equal(snap.returnedByTool['list-tasks'], 1);
  });

  test('recordAnchorReturned accumulates returnedChars per tool (raw sum, not averaged)', () => {
    recordAnchorReturned({ tool: 'pending-mentions', returnedChars: 100 });
    recordAnchorReturned({ tool: 'pending-mentions', returnedChars: 50 });
    const snap = getAnchorTelemetrySnapshot();
    assert.equal(snap.returnedCharsByTool['pending-mentions'], 150);
  });

  test('recordAnchorFullDrill tallies count and chars per tool', () => {
    recordAnchorFullDrill({ tool: 'get-message', fullDrillChars: 400 });
    recordAnchorFullDrill({ tool: 'get-message', fullDrillChars: 600 });
    const snap = getAnchorTelemetrySnapshot();
    assert.equal(snap.drillByTool['get-message'], 2);
    assert.equal(snap.drillCharsByTool['get-message'], 1000);
  });

  // Regression for gpt52 review P1: list-tasks?taskId=... returns the task's FULL
  // why (a drill-volume response), NOT a preview. It must land in the drill-volume
  // tally, never in the preview-return tally — otherwise the tool's request/response
  // volume accounting is corrupted.
  test('list-tasks taskId drill records as drill-volume, not preview-volume', () => {
    // preview (no taskId)
    recordAnchorReturned({ tool: 'list-tasks', returnedChars: 30 });
    // drill (taskId present) — full why served
    recordAnchorFullDrill({ tool: 'list-tasks', fullDrillChars: 500 });
    const snap = getAnchorTelemetrySnapshot();
    // drill counted under drillByTool, keyed by the list-tasks tool
    assert.equal(snap.drillByTool['list-tasks'], 1);
    assert.equal(snap.drillCharsByTool['list-tasks'], 500);
    // and NOT double-counted into the preview return tally
    assert.equal(snap.returnedByTool['list-tasks'], 1, 'only the no-taskId preview counts as a return');
    assert.equal(snap.returnedCharsByTool['list-tasks'], 30);
  });

  test('volume-substrate-only: snapshot does NOT expose a derived anchorOpenRate / ratio', () => {
    // The recorder is a chars + request/response volume substrate; any drill↔preview
    // open-rate needs a correlated event model and is Track-2's scope, never derived here.
    recordAnchorReturned({ tool: 'pending-mentions', returnedChars: 100 });
    recordAnchorFullDrill({ tool: 'get-message', fullDrillChars: 400 });
    const snap = getAnchorTelemetrySnapshot();
    assert.equal(snap.anchorOpenRate, undefined, 'recorder must not pre-compute open rate');
    assert.equal(snap.ratio, undefined, 'recorder must not pre-compute drill/returned ratio');
  });

  test('ANCHOR_TOOL attribute is allowlisted (otherwise the per-tool breakdown is silently dropped by the SDK)', async () => {
    const { ANCHOR_TOOL } = await import('../dist/infrastructure/telemetry/genai-semconv.js');
    const { ALLOWED_METRIC_ATTRIBUTES } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
    assert.equal(ANCHOR_TOOL, 'anchor.tool', 'pin the cross-package Prometheus label literal');
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has(ANCHOR_TOOL),
      `metric-allowlist must include ${ANCHOR_TOOL} so anchor counters can attribute by tool`,
    );
  });

  test('anchor OTel instruments are exported with cat_cafe.anchor.* names', async () => {
    const instruments = await import('../dist/infrastructure/telemetry/instruments.js');
    // Lazy proxies — assert they exist so a rename/removal is caught here.
    assert.ok(instruments.anchorReturnedCount, 'anchorReturnedCount instrument must be exported');
    assert.ok(instruments.anchorReturnedChars, 'anchorReturnedChars instrument must be exported');
    assert.ok(instruments.anchorFullDrillCount, 'anchorFullDrillCount instrument must be exported');
    assert.ok(instruments.anchorFullDrillChars, 'anchorFullDrillChars instrument must be exported');
  });
});
