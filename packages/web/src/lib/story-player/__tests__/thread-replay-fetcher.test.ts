/**
 * F252 Phase E — Thread-level session event merging
 *
 * Tests the pure merge function that combines events from multiple sessions
 * into a single sorted timeline for thread-level replay.
 */

import { describe, expect, it } from 'vitest';
import { mergeSessionEvents } from '../merge-session-events';
import type { RawTranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawEvent(overrides: Partial<RawTranscriptEvent> = {}): RawTranscriptEvent {
  return {
    v: 1,
    t: 1000,
    threadId: 'thread_1',
    catId: 'opus',
    sessionId: 'session_1',
    cliSessionId: 'cli_1',
    eventNo: 0,
    event: { type: 'text' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeSessionEvents', () => {
  it('merges events from multiple sessions sorted by timestamp (INV-5)', () => {
    const session1 = [
      makeRawEvent({ t: 1000, eventNo: 0, sessionId: 'a', catId: 'opus' }),
      makeRawEvent({ t: 3000, eventNo: 1, sessionId: 'a', catId: 'opus' }),
    ];
    const session2 = [
      makeRawEvent({ t: 2000, eventNo: 0, sessionId: 'b', catId: 'codex' }),
      makeRawEvent({ t: 4000, eventNo: 1, sessionId: 'b', catId: 'codex' }),
    ];

    const merged = mergeSessionEvents([session1, session2]);

    // Sorted by t
    expect(merged.map((e) => e.t)).toEqual([1000, 2000, 3000, 4000]);
    // Interleaved session IDs
    expect(merged.map((e) => e.sessionId)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('re-indexes eventNo monotonically after merge', () => {
    const session1 = [makeRawEvent({ t: 2000, eventNo: 0 })];
    const session2 = [makeRawEvent({ t: 1000, eventNo: 0 })];

    const merged = mergeSessionEvents([session1, session2]);

    expect(merged[0].eventNo).toBe(0);
    expect(merged[1].eventNo).toBe(1);
  });

  it('handles empty session list', () => {
    expect(mergeSessionEvents([])).toEqual([]);
  });

  it('handles single session passthrough', () => {
    const events = [makeRawEvent({ t: 1000, eventNo: 0 }), makeRawEvent({ t: 2000, eventNo: 1 })];

    const merged = mergeSessionEvents([events]);

    expect(merged).toHaveLength(2);
    expect(merged[0].t).toBe(1000);
    expect(merged[1].t).toBe(2000);
  });

  it('handles sessions with empty event arrays', () => {
    const merged = mergeSessionEvents([[], [], []]);
    expect(merged).toEqual([]);
  });

  it('preserves all original fields except re-indexed eventNo', () => {
    const event = makeRawEvent({
      t: 5000,
      eventNo: 42,
      catId: 'codex',
      sessionId: 'sess_abc',
      invocationId: 'inv_xyz',
      event: { type: 'tool_use', toolName: 'Read' },
    });

    const merged = mergeSessionEvents([[event]]);

    expect(merged[0].catId).toBe('codex');
    expect(merged[0].sessionId).toBe('sess_abc');
    expect(merged[0].invocationId).toBe('inv_xyz');
    expect(merged[0].event).toEqual({ type: 'tool_use', toolName: 'Read' });
    // eventNo re-indexed
    expect(merged[0].eventNo).toBe(0);
  });

  it('handles many sessions with overlapping timestamps', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => [
      makeRawEvent({ t: 1000 + i * 100, eventNo: 0, sessionId: `s${i}` }),
      makeRawEvent({ t: 2000 + i * 100, eventNo: 1, sessionId: `s${i}` }),
    ]);

    const merged = mergeSessionEvents(sessions);

    expect(merged).toHaveLength(10);
    // Timestamps should be monotonically non-decreasing
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].t).toBeGreaterThanOrEqual(merged[i - 1].t);
    }
    // eventNo should be 0..9
    expect(merged.map((e) => e.eventNo)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is stable sort — preserves relative order of same-timestamp events', () => {
    const events = [
      makeRawEvent({ t: 1000, eventNo: 0, sessionId: 'first' }),
      makeRawEvent({ t: 1000, eventNo: 1, sessionId: 'second' }),
      makeRawEvent({ t: 1000, eventNo: 2, sessionId: 'third' }),
    ];

    const merged = mergeSessionEvents([events]);

    // Same-timestamp events keep original order
    expect(merged.map((e) => e.sessionId)).toEqual(['first', 'second', 'third']);
  });
});
