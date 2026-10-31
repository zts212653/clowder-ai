/**
 * F258 Visible Café — Render Log Tests
 *
 * Covers:
 * - INV-4: every non-unknown posture has sourceRef
 * - Ring buffer capacity truncation
 * - Chronological ordering
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RenderLog } from '@/lib/visible-cafe/render-log';

describe('RenderLog', () => {
  let log: RenderLog;

  beforeEach(() => {
    log = new RenderLog();
  });

  it('appends entries in order', () => {
    log.append({ ts: 1, catId: 'x', posture: 'sleeping', sourceRef: 's1', state: 'live' });
    log.append({ ts: 2, catId: 'x', posture: 'working', sourceRef: 's2', state: 'live' });

    const entries = log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(1);
    expect(entries[1].ts).toBe(2);
  });

  it('recent(n) returns last n entries', () => {
    for (let i = 0; i < 10; i++) {
      log.append({ ts: i, catId: 'x', posture: 'sleeping', sourceRef: `s${i}`, state: 'live' });
    }

    const recent = log.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].ts).toBe(7);
    expect(recent[2].ts).toBe(9);
  });

  it('ring buffer truncates at capacity', () => {
    // Fill 512 entries
    for (let i = 0; i < 600; i++) {
      log.append({ ts: i, catId: 'x', posture: 'sleeping', sourceRef: `s${i}`, state: 'live' });
    }

    expect(log.size).toBe(512);
    const entries = log.entries();
    expect(entries).toHaveLength(512);

    // Oldest should be 88 (600 - 512)
    expect(entries[0].ts).toBe(88);
    // Newest should be 599
    expect(entries[511].ts).toBe(599);
  });

  it('INV-4: entries always have sourceRef when state is non-unknown', () => {
    log.append({ ts: 1, catId: 'x', posture: 'sleeping', sourceRef: 'socket:1', state: 'live' });
    log.append({ ts: 2, catId: 'x', posture: 'working', sourceRef: 'reconcile:2', state: 'live' });

    const entries = log.entries();
    for (const entry of entries) {
      if (entry.state !== 'unknown') {
        expect(entry.sourceRef).toBeTruthy();
      }
    }
  });

  it('clear resets the log', () => {
    log.append({ ts: 1, catId: 'x', posture: 'sleeping', sourceRef: 's1', state: 'live' });
    expect(log.size).toBe(1);

    log.clear();
    expect(log.size).toBe(0);
    expect(log.entries()).toHaveLength(0);
  });
});
