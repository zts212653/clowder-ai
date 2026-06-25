/**
 * F236 Track-2 — AnchorEventLog rollup core tests.
 *
 * Tests the per-tool open-rate rollup algorithm: preview↔drill join, cross-tool
 * attribution, duplicate handling, window filtering, and net benefit calculation.
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

describe('AnchorEventLog — rollup (core)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('computes per-tool open-rate from preview↔drill join', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1', 'msg-2', 'msg-3'],
      returnedChars: 500,
      originalChars: 5000,
      _testTimestamp: now,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-2',
      fullDrillChars: 2000,
      _testTimestamp: now + 1,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    const tc = rollup.perTool['thread-context'];
    assert.ok(tc !== undefined);
    assert.strictEqual(tc.previewResponses, 1);
    assert.strictEqual(tc.previewedItems, 3);
    assert.strictEqual(tc.drills, 1);
    assert.strictEqual(tc.drilledUniqueItems, 1);
    assert.ok(Math.abs(tc.openRateByItem - 1 / 3) < 0.01);
    assert.strictEqual(tc.charsSaved, 5000 - 500);
    assert.strictEqual(tc.drillChars, 2000);
    assert.strictEqual(tc.netBenefit, 4500 - 2000);
  });

  it('tracks orphan drills (drill with no matching preview)', () => {
    const now = Date.now();
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-orphan',
      fullDrillChars: 1000,
      _testTimestamp: now,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.orphanDrills, 1);
  });

  it('rollup window filters events by timestamp', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now - 2 * 60 * 60 * 1000,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-2'],
      returnedChars: 200,
      originalChars: 2000,
      _testTimestamp: now,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 60 * 60 * 1000,
      windowEndMs: now + 60000,
    });
    assert.strictEqual(rollup.perTool['thread-context'].previewResponses, 1);
    assert.strictEqual(rollup.perTool['thread-context'].previewedItems, 1);
  });

  it('joins drills to correct preview tool across tools', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-A', 'msg-B'],
      returnedChars: 300,
      originalChars: 3000,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-C'],
      returnedChars: 100,
      originalChars: 800,
      _testTimestamp: now,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-A',
      fullDrillChars: 1500,
      _testTimestamp: now + 1,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-C',
      fullDrillChars: 700,
      _testTimestamp: now + 2,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drillChars, 1500);
    assert.strictEqual(rollup.perTool['pending-mentions'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['pending-mentions'].drillChars, 700);
    assert.strictEqual(rollup.orphanDrills, 0);
  });

  it('handles duplicate drill for same item (counts unique)', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1', 'msg-2'],
      returnedChars: 200,
      originalChars: 2000,
      _testTimestamp: now,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-1',
      fullDrillChars: 1000,
      _testTimestamp: now + 1,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-1',
      fullDrillChars: 1000,
      _testTimestamp: now + 2,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['thread-context'].drills, 2);
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['thread-context'].drillChars, 2000);
  });

  it('handles item appearing in multiple preview tools (attribute to most recent before drill)', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-X'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: now,
    });
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-X'],
      returnedChars: 80,
      originalChars: 1000,
      _testTimestamp: now + 100,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-X',
      fullDrillChars: 900,
      _testTimestamp: now + 200,
    });

    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['pending-mentions'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['pending-mentions'].drillChars, 900);
    assert.strictEqual(rollup.perTool['thread-context'].drilledUniqueItems, 0);
  });

  it('returns empty perTool when no events in window', () => {
    const now = Date.now();
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 1000,
    });
    assert.deepStrictEqual(rollup.perTool, {});
    assert.strictEqual(rollup.orphanDrills, 0);
  });

  it('zero division: openRateByItem is 0 when no items previewed', () => {
    const now = Date.now();
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-1',
      fullDrillChars: 500,
      _testTimestamp: now,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.orphanDrills, 1);
  });

  it('list-tasks drill joins to list-tasks preview', () => {
    const now = Date.now();
    recordAnchorPreviewEvent({
      tool: 'list-tasks',
      itemIds: ['task-1', 'task-2'],
      returnedChars: 300,
      originalChars: 3000,
      _testTimestamp: now,
    });
    recordAnchorDrillEvent({
      tool: 'list-tasks',
      itemId: 'task-1',
      fullDrillChars: 1500,
      _testTimestamp: now + 1,
    });
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 10000,
    });
    assert.strictEqual(rollup.perTool['list-tasks'].drilledUniqueItems, 1);
    assert.strictEqual(rollup.perTool['list-tasks'].previewedItems, 2);
    assert.strictEqual(rollup.perTool['list-tasks'].drillChars, 1500);
  });

  it('includes Track-1 snapshot in rollup for cross-reference', () => {
    const now = Date.now();
    const rollup = getAnchorTelemetryRollup({
      windowStartMs: now - 1000,
      windowEndMs: now + 1000,
    });
    assert.ok(rollup.track1Snapshot !== undefined);
    assert.ok(rollup.track1Snapshot.returnedByTool !== undefined);
    assert.ok(rollup.track1Snapshot.drillByTool !== undefined);
  });
});
