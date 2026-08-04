/**
 * Cursor v2 activation gate integration test (#1269 contract, revised)
 *
 * Revised contract (maintainer review 2026-08-04):
 *   - cursorFor() always produces canonical v2 when visibilitySeq is known
 *     (NOT gated — CAS comparison/advancement must be v2-coherent in both modes)
 *   - gateForDurableSlot() controls whether untouched durable slots initiate v2
 *   - Existing v2 slots remain advanceable regardless of activation mode
 *
 * Tests:
 *   1. cursorFor() is always v2 regardless of gate state
 *   2. gateForDurableSlot() respects gate for untouched slots
 *   3. gateForDurableSlot() always returns v2 for existing v2 slots (rollback-safe)
 *   4. Rollback lifecycle: on → off preserves v2 advancement
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { cursorFor, parseCursor, compareCursors } = await import('../dist/domains/cats/services/stores/cursor.js');
const { gateForDurableSlot } = await import('../dist/domains/cats/services/stores/cursor-activation.js');

const msg = { id: '0000000000100000-000001-abcdef01', visibilitySeq: 100000 };
const msgNoSeq = { id: '0000000000200000-000002-abcdef02' };

describe('Cursor v2 activation gate (#1269 revised)', () => {
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

  // ── cursorFor: always canonical v2 ──

  it('cursorFor produces v2 when gate is unset (canonical coordinate)', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.ok(cursor.startsWith('v2:'), 'cursorFor must produce v2 regardless of gate');
    const parsed = parseCursor(cursor);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.seq, msg.visibilitySeq);
    assert.equal(parsed.id, msg.id);
  });

  it('cursorFor produces v2 when gate is "off" (canonical coordinate)', (t) => {
    const restore = withActivation('off');
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.ok(cursor.startsWith('v2:'), 'cursorFor must produce v2 even with explicit off');
  });

  it('cursorFor produces v2 when gate is "on" (canonical coordinate)', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const cursor = cursorFor(msg);
    assert.ok(cursor.startsWith('v2:'), 'cursorFor must produce v2 when on');
    const parsed = parseCursor(cursor);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.seq, msg.visibilitySeq);
  });

  it('cursorFor returns raw ID when visibilitySeq is absent (regardless of gate)', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const cursor = cursorFor(msgNoSeq);
    assert.equal(cursor, msgNoSeq.id, 'no visibilitySeq → raw ID fallback');
    assert.ok(!cursor.startsWith('v2:'));
  });

  // ── gateForDurableSlot: controls untouched slot initiation ──

  it('gate OFF + untouched slot → v1 (raw ID)', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);

    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, null);
    assert.equal(durable, msg.id, 'untouched slot with gate off must get v1');
  });

  it('gate OFF + existing v1 slot → v1 (raw ID)', (t) => {
    const restore = withActivation('off');
    t.after(restore);

    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, 'some-old-v1-cursor');
    assert.equal(durable, msg.id, 'v1 slot with gate off must stay v1');
  });

  it('gate ON + untouched slot → v2 (initiate)', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, null);
    assert.equal(durable, canonical, 'gate on must initiate v2 in untouched slot');
    assert.ok(durable.startsWith('v2:'));
  });

  it('gate ON + existing v1 slot → v2 (upgrade)', (t) => {
    const restore = withActivation('on');
    t.after(restore);

    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, 'some-old-v1-cursor');
    assert.equal(durable, canonical, 'gate on must upgrade v1 slot to v2');
  });

  // ── Rollback safety: existing v2 slots always advance in v2 ──

  it('gate OFF + existing v2 slot → v2 (rollback-safe advancement)', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);

    const existingV2 = 'v2:0000000000000001:old-msg';
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, existingV2);
    assert.equal(durable, canonical, 'existing v2 slot must advance in v2 even with gate off');
    assert.ok(durable.startsWith('v2:'));
  });

  it('gate "off" + existing v2 slot → v2 (explicit off is still rollback-safe)', (t) => {
    const restore = withActivation('off');
    t.after(restore);

    const existingV2 = 'v2:0000000000000050:prev-msg';
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, msg, existingV2);
    assert.equal(durable, canonical, 'explicit off must not freeze existing v2');
  });

  // ── Full rollback lifecycle: off → on → off ──

  it('full lifecycle: off → on → off preserves v2 advancement', (t) => {
    // Phase 1: OFF — untouched slot gets v1
    let restore = withActivation(undefined);
    const canonical1 = cursorFor(msg);
    const durable1 = gateForDurableSlot(canonical1, msg, null);
    assert.equal(durable1, msg.id, 'Phase 1: v1 for untouched slot');
    restore();

    // Phase 2: ON — slot initiates v2
    restore = withActivation('on');
    const msg2 = { id: 'msg-phase2', visibilitySeq: 200000 };
    const canonical2 = cursorFor(msg2);
    const durable2 = gateForDurableSlot(canonical2, msg2, durable1);
    assert.ok(durable2.startsWith('v2:'), 'Phase 2: v2 initiated');
    restore();

    // Phase 3: OFF (rollback) — existing v2 slot still advances in v2
    restore = withActivation(undefined);
    t.after(restore);
    const msg3 = { id: 'msg-phase3', visibilitySeq: 300000 };
    const canonical3 = cursorFor(msg3);
    const durable3 = gateForDurableSlot(canonical3, msg3, durable2);
    assert.ok(durable3.startsWith('v2:'), 'Phase 3: v2 advancement survives rollback');

    // Verify ordering: phase3 > phase2
    assert.ok(compareCursors(durable3, durable2) > 0, 'Phase 3 cursor must be later than Phase 2');
  });

  // ── Canonical v2 comparison works in both modes ──

  it('canonical v2 cursors compare correctly when gate is off', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);

    const earlier = cursorFor({ id: 'msg-a', visibilitySeq: 100 });
    const later = cursorFor({ id: 'msg-b', visibilitySeq: 200 });
    assert.ok(compareCursors(earlier, later) < 0, 'earlier seq must compare less');
    assert.ok(compareCursors(later, earlier) > 0, 'later seq must compare greater');
  });
});
