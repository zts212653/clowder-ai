/**
 * Cursor v2 activation gate integration test (#1269 contract)
 *
 * Verifies the off -> on -> off lifecycle:
 *   1. OFF (default): cursorFor always returns v1 (raw message ID)
 *   2. ON: cursorFor returns v2 for messages with visibilitySeq
 *   3. OFF again (rollback): v2 cursors still parseable, new cursors degrade to v1
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { cursorFor, parseCursor, compareCursors } = await import('../dist/domains/cats/services/stores/cursor.js');

const msg = { id: '0000000000100000-000001-abcdef01', visibilitySeq: 100000 };
const msgNoSeq = { id: '0000000000200000-000002-abcdef02' };

describe('Cursor v2 activation gate (#1269)', () => {
  /** Save and restore env between tests */
  function withActivation(value) {
    const saved = process.env.VISIBILITY_CURSOR_V2;
    if (value === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = value;
    return () => {
      if (saved === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = saved;
    };
  }

  // ── Phase 1: OFF (default) ──

  it('returns v1 (raw ID) when VISIBILITY_CURSOR_V2 is unset', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.equal(cursor, msg.id, 'cursorFor must return raw ID when v2 is not active');
    assert.ok(!cursor.startsWith('v2:'), 'cursor must not be v2 format');
  });

  it('returns v1 (raw ID) when VISIBILITY_CURSOR_V2 is empty string', (t) => {
    const restore = withActivation('');
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.equal(cursor, msg.id);
  });

  it('returns v1 (raw ID) when VISIBILITY_CURSOR_V2 is "off"', (t) => {
    const restore = withActivation('off');
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.equal(cursor, msg.id);
  });

  it('returns raw ID for messages without visibilitySeq regardless of gate', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const cursor = cursorFor(msgNoSeq);
    assert.equal(cursor, msgNoSeq.id, 'messages without visibilitySeq always get v1');
  });

  // ── Phase 2: ON ──

  it('returns v2 cursor when VISIBILITY_CURSOR_V2=on and msg has visibilitySeq', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.ok(cursor.startsWith('v2:'), 'cursor must be v2 format');

    const parsed = parseCursor(cursor);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.seq, msg.visibilitySeq);
    assert.equal(parsed.id, msg.id);
  });

  // ── Phase 3: OFF again (rollback) ──

  it('existing v2 cursors remain parseable after rollback to OFF', (t) => {
    // Simulate: cursor was created while ON
    const restoreOn = withActivation('on');
    const v2Cursor = cursorFor(msg);
    restoreOn();

    // Now OFF
    const restoreOff = withActivation(undefined);
    t.after(restoreOff);

    // v2 cursor still parses correctly
    const parsed = parseCursor(v2Cursor);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.seq, msg.visibilitySeq);
    assert.equal(parsed.id, msg.id);

    // New cursors are v1
    const newCursor = cursorFor(msg);
    assert.equal(newCursor, msg.id, 'new cursors degrade to v1 after rollback');
  });

  it('v2 cursors compare correctly against v1 cursors (cross-format = 0)', (t) => {
    const restoreOn = withActivation('on');
    const v2Cursor = cursorFor(msg);
    restoreOn();

    const restoreOff = withActivation(undefined);
    t.after(restoreOff);

    const v1Cursor = cursorFor(msg);

    // Cross-format comparison returns 0 (indeterminate) by design
    assert.equal(compareCursors(v2Cursor, v1Cursor), 0, 'cross-format comparison must return 0 (indeterminate)');
  });
});
