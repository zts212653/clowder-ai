/**
 * F236 Track-2 — AnchorEventLog rollup temporal causality + regression tests.
 *
 * Tests timeline-interleaved drill attribution (drill before preview = orphan,
 * drill between previews = attributed to earlier one) and cloud review regression
 * tests (unique item counting, exclusive windowEndMs).
 * Split from anchor-event-log.test.js (cloud R3 P1: 350-line file cap).
 *
 * Uses node:test (project test runner convention).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  getAnchorTelemetryRollup,
  recordAnchorDrillEvent,
  recordAnchorPreviewEvent,
  resetAnchorEventLogForTest,
} from '../dist/routes/anchor-event-log.js';

describe('AnchorEventLog — rollup (temporal causality)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('drill before any preview of that item is orphan (temporal causality)', () => {
    const now = Date.now();
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-late-preview',
      fullDrillChars: 1000,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-late-preview'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now + 500,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.orphanDrills, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 0);
    assert.strictEqual(rollup.perTool['thread-context'].drills, 0);
  });

  it('drill after preview is attributed, drill before preview is orphan (mixed)', () => {
    const now = Date.now();
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-A',
      fullDrillChars: 500,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-A', 'msg-B'],
      returnedChars: 200,
      originalChars: 2000,
      _testTimestamp: now + 100,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-B',
      fullDrillChars: 800,
      _testTimestamp: now + 200,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.orphanDrills, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drills, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drillChars, 800);
  });

  it('drill between two previews attributes to the earlier preview tool, not the later one', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-X'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-X',
      fullDrillChars: 900,
      _testTimestamp: now + 50,
    });
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-X'],
      returnedChars: 80,
      originalChars: 1000,
      _testTimestamp: now + 100,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drillChars, 900);
    assert.strictEqual(rollup.perTool['pending-mentions'].drilledUniqueItems, 0);
    assert.strictEqual(rollup.perTool['pending-mentions'].drills, 0);
    assert.strictEqual(rollup.orphanDrills, 0);
  });
});

describe('AnchorEventLog — rollup (regression)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('previewedItems counts unique items, not exposures (cloud R2 P1)', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-A', 'msg-B'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-A', 'msg-B', 'msg-C'],
      returnedChars: 150,
      originalChars: 1500,
      _testTimestamp: now + 100,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-A',
      fullDrillChars: 500,
      _testTimestamp: now + 200,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['pending-mentions'].previewedItems, 3);
    assert.strictEqual(rollup.perTool['pending-mentions'].drilledUniqueItems, 1);
    assert.ok(Math.abs(rollup.perTool['pending-mentions'].openRateByItem - 1 / 3) < 0.001);
  });

  it('windowEndMs is exclusive (cloud R2 P2)', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-inside'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-boundary'],
      returnedChars: 200,
      originalChars: 2000,
      _testTimestamp: now + 5000,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 5000,
    });
    assert.strictEqual(rollup.perTool['thread-context'].previewedItems, 1);
    assert.strictEqual(rollup.perTool['thread-context'].previewResponses, 1);
  });

  it('same-ms drill recorded before preview uses event ID ordering, not kind (cloud R4 P2)', () => {
    const now = Date.now();
    // Drill recorded FIRST (gets lower event ID), then preview at same ms
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-same-ms',
      fullDrillChars: 500,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-same-ms'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now, // same ms as drill
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    // Drill was recorded first (lower event ID) → processes before preview
    // → no preview existed yet → orphan, NOT attributed to the later preview
    assert.strictEqual(rollup.orphanDrills, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 0);
    assert.strictEqual(rollup.perTool['thread-context'].drills, 0);
  });
});
