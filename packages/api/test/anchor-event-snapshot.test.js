/**
 * F236 Track-2 — AnchorEventLog snapshot + eviction tests.
 *
 * Tests the in-memory ring buffer snapshot (copy-on-read) and 24h TTL eviction.
 * Split from anchor-event-log.test.js (cloud R3 P1: 350-line file cap).
 *
 * Uses node:test (project test runner convention).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  getAnchorEventSnapshot,
  recordAnchorDrillEvent,
  recordAnchorPreviewEvent,
  resetAnchorEventLogForTest,
} from '../dist/routes/anchor-event-log.js';

describe('AnchorEventLog — snapshot', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('starts empty', () => {
    const snap = getAnchorEventSnapshot();
    assert.deepStrictEqual(snap.previewEvents, []);
    assert.deepStrictEqual(snap.drillEvents, []);
  });

  it('records preview events with correlation keys', () => {
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1', 'msg-2', 'msg-3'],
      returnedChars: 500,
      originalChars: 5000,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1);
    const ev = snap.previewEvents[0];
    assert.strictEqual(ev.tool, 'thread-context');
    assert.deepStrictEqual(ev.itemIds, ['msg-1', 'msg-2', 'msg-3']);
    assert.strictEqual(ev.itemCount, 3);
    assert.strictEqual(ev.returnedChars, 500);
    assert.strictEqual(ev.originalChars, 5000);
    assert.strictEqual(typeof ev.id, 'string');
    assert.strictEqual(typeof ev.timestamp, 'number');
  });

  it('records drill events with itemId correlation', () => {
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-2',
      fullDrillChars: 3000,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.drillEvents.length, 1);
    const ev = snap.drillEvents[0];
    assert.strictEqual(ev.tool, 'get-message');
    assert.strictEqual(ev.itemId, 'msg-2');
    assert.strictEqual(ev.fullDrillChars, 3000);
  });

  it('assigns monotonically increasing event IDs', () => {
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['m1'],
      returnedChars: 100,
      originalChars: 1000,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'm1',
      fullDrillChars: 800,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['m2'],
      returnedChars: 200,
      originalChars: 2000,
    });
    const snap = getAnchorEventSnapshot();
    const ids = [...snap.previewEvents.map((e) => Number(e.id)), ...snap.drillEvents.map((e) => Number(e.id))].sort(
      (a, b) => a - b,
    );
    assert.strictEqual(new Set(ids).size, 3);
    assert.ok(ids[2] > ids[1]);
    assert.ok(ids[1] > ids[0]);
  });

  it('snapshot is a copy (mutations do not affect internal state)', () => {
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1'],
      returnedChars: 100,
      originalChars: 1000,
    });
    const snap1 = getAnchorEventSnapshot();
    snap1.previewEvents.push(/** @type {any} */ ({ fake: true }));
    const snap2 = getAnchorEventSnapshot();
    assert.strictEqual(snap2.previewEvents.length, 1);
  });
});

describe('AnchorEventLog — eviction (INV-2: 24h TTL)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('evicts events older than 24h on write', () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-old'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: twentyFiveHoursAgo,
    });
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-new'],
      returnedChars: 100,
      originalChars: 1000,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1);
    assert.deepStrictEqual(snap.previewEvents[0].itemIds, ['msg-new']);
  });

  it('evicts drill events older than 24h on write', () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-old',
      fullDrillChars: 500,
      _testTimestamp: twentyFiveHoursAgo,
    });
    recordAnchorDrillEvent({
      tool: 'get-message',
      itemId: 'msg-new',
      fullDrillChars: 600,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.drillEvents.length, 1);
    assert.strictEqual(snap.drillEvents[0].itemId, 'msg-new');
  });

  it('records empty-itemIds previews for adoption while leaving no join keys', () => {
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: [],
      returnedChars: 0,
      originalChars: 0,
      modeResolved: 'anchor',
      modeSource: 'default',
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1, 'zero-result calls still count for adoption');
    assert.deepStrictEqual(snap.previewEvents[0].itemIds, []);
    assert.strictEqual(snap.previewEvents[0].itemCount, 0);
    assert.strictEqual(snap.previewEvents[0].modeResolved, 'anchor');
    assert.strictEqual(snap.previewEvents[0].modeSource, 'default');
  });

  it('keeps events within 24h window', () => {
    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60 * 1000;
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-recent'],
      returnedChars: 100,
      originalChars: 1000,
      _testTimestamp: twentyThreeHoursAgo,
    });
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-now'],
      returnedChars: 200,
      originalChars: 2000,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 2);
  });
});

describe('AnchorEventLog — adoption eval fields (F236 Track-1 gpt52 R1 P1/P2)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('stores modeResolved + modeSource + catId on preview events', () => {
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1'],
      returnedChars: 100,
      originalChars: 100,
      modeResolved: 'full',
      modeSource: 'explicit',
      catId: 'opus',
    });
    const snap = getAnchorEventSnapshot();
    const ev = snap.previewEvents[0];
    assert.strictEqual(ev.modeResolved, 'full');
    assert.strictEqual(ev.modeSource, 'explicit');
    assert.strictEqual(ev.catId, 'opus');
  });

  it('stores anchor/default mode fields for default anchor calls', () => {
    recordAnchorPreviewEvent({
      tool: 'pending-mentions',
      itemIds: ['msg-2'],
      returnedChars: 50,
      originalChars: 500,
      modeResolved: 'anchor',
      modeSource: 'default',
      catId: 'sonnet',
    });
    const snap = getAnchorEventSnapshot();
    const ev = snap.previewEvents[0];
    assert.strictEqual(ev.modeResolved, 'anchor');
    assert.strictEqual(ev.modeSource, 'default');
    assert.strictEqual(ev.catId, 'sonnet');
  });

  it('omits adoption fields when not provided (backward compat)', () => {
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-3'],
      returnedChars: 200,
      originalChars: 2000,
    });
    const snap = getAnchorEventSnapshot();
    const ev = snap.previewEvents[0];
    assert.strictEqual(ev.modeResolved, undefined);
    assert.strictEqual(ev.modeSource, undefined);
    assert.strictEqual(ev.catId, undefined);
  });
});

describe('AnchorEventLog — cc native tools (F236 Phase C)', () => {
  beforeEach(() => resetAnchorEventLogForTest());

  it('records cc-read preview events with adoption fields', () => {
    recordAnchorPreviewEvent({
      tool: 'cc-read',
      itemIds: ['file:/src/foo.ts'],
      returnedChars: 80,
      originalChars: 5000,
      modeResolved: 'anchor',
      modeSource: 'explicit',
      catId: 'opus',
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1);
    const ev = snap.previewEvents[0];
    assert.strictEqual(ev.tool, 'cc-read');
    assert.strictEqual(ev.modeResolved, 'anchor');
    assert.strictEqual(ev.modeSource, 'explicit');
    assert.strictEqual(ev.returnedChars, 80);
    assert.strictEqual(ev.originalChars, 5000);
  });

  it('records cc-grep preview events', () => {
    recordAnchorPreviewEvent({
      tool: 'cc-grep',
      itemIds: ['grep:TODO'],
      returnedChars: 150,
      originalChars: 3000,
      modeResolved: 'anchor',
      modeSource: 'explicit',
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1);
    assert.strictEqual(snap.previewEvents[0].tool, 'cc-grep');
  });

  it('records cc-glob preview events', () => {
    recordAnchorPreviewEvent({
      tool: 'cc-glob',
      itemIds: ['glob:src/**/*.ts'],
      returnedChars: 100,
      originalChars: 2000,
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 1);
    assert.strictEqual(snap.previewEvents[0].tool, 'cc-glob');
  });

  it('cc tools participate in rollup alongside MCP tools', () => {
    // MCP tool event
    recordAnchorPreviewEvent({
      tool: 'thread-context',
      itemIds: ['msg-1'],
      returnedChars: 100,
      originalChars: 1000,
    });
    // cc tool event
    recordAnchorPreviewEvent({
      tool: 'cc-read',
      itemIds: ['file:/a.ts'],
      returnedChars: 50,
      originalChars: 5000,
      modeResolved: 'anchor',
      modeSource: 'explicit',
    });
    const snap = getAnchorEventSnapshot();
    assert.strictEqual(snap.previewEvents.length, 2);
    // Both tool types coexist
    const tools = snap.previewEvents.map((e) => e.tool);
    assert.ok(tools.includes('thread-context'));
    assert.ok(tools.includes('cc-read'));
  });
});
