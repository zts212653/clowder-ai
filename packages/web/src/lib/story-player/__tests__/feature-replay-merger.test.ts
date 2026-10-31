/**
 * F252 Phase E PR E-4 — Feature Replay Event Merger Tests
 *
 * AC-E5: Merge events from multiple threads into a single time-sorted
 * stream for unified feature-level replay.
 */
import { describe, expect, it } from 'vitest';
import { mergeFeatureEvents } from '../feature-replay-merger';
import type { RawTranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(
  threadId: string,
  t: number,
  eventNo: number,
  overrides: Partial<RawTranscriptEvent> = {},
): RawTranscriptEvent {
  return {
    v: 1,
    t,
    threadId,
    catId: 'opus',
    sessionId: `s-${threadId}`,
    cliSessionId: 'cs1',
    eventNo,
    event: { type: 'text', content: `msg-${threadId}-${eventNo}` },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeFeatureEvents', () => {
  it('merges events from multiple threads sorted by timestamp', () => {
    const threadEvents = new Map([
      ['t1', [makeRaw('t1', 1000, 0), makeRaw('t1', 3000, 1)]],
      ['t2', [makeRaw('t2', 2000, 0), makeRaw('t2', 4000, 1)]],
    ]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged.map((e) => e.threadId)).toEqual(['t1', 't2', 't1', 't2']);
    expect(merged.map((e) => e.t)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('re-indexes eventNo monotonically after merge', () => {
    const threadEvents = new Map([
      ['t1', [makeRaw('t1', 1000, 0), makeRaw('t1', 3000, 1)]],
      ['t2', [makeRaw('t2', 2000, 0)]],
    ]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged.map((e) => e.eventNo)).toEqual([0, 1, 2]);
  });

  it('preserves original threadId on each event', () => {
    const threadEvents = new Map([
      ['t1', [makeRaw('t1', 1000, 0)]],
      ['t2', [makeRaw('t2', 2000, 0)]],
    ]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged[0].threadId).toBe('t1');
    expect(merged[1].threadId).toBe('t2');
  });

  it('handles empty thread map', () => {
    expect(mergeFeatureEvents(new Map())).toEqual([]);
  });

  it('handles single thread', () => {
    const threadEvents = new Map([['t1', [makeRaw('t1', 1000, 0), makeRaw('t1', 2000, 1)]]]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged).toHaveLength(2);
    expect(merged[0].threadId).toBe('t1');
  });

  it('handles thread with empty event array', () => {
    const threadEvents = new Map<string, RawTranscriptEvent[]>([
      ['t1', [makeRaw('t1', 1000, 0)]],
      ['t2', []],
    ]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged).toHaveLength(1);
  });

  it('stable sort preserves intra-thread order for same-timestamp events', () => {
    // Two events from t1 at same timestamp, one from t2 at same timestamp
    const threadEvents = new Map([
      [
        't1',
        [
          makeRaw('t1', 1000, 0, { event: { type: 'text', content: 'first' } }),
          makeRaw('t1', 1000, 1, { event: { type: 'text', content: 'second' } }),
        ],
      ],
      ['t2', [makeRaw('t2', 1000, 0, { event: { type: 'text', content: 'other' } })]],
    ]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged).toHaveLength(3);
    // All at t=1000 — stable sort preserves insertion order (t1 events before t2)
    expect(merged.every((e) => e.t === 1000)).toBe(true);
    // t1's events stay in original relative order
    const t1Events = merged.filter((e) => e.threadId === 't1');
    expect((t1Events[0].event as Record<string, unknown>).content).toBe('first');
    expect((t1Events[1].event as Record<string, unknown>).content).toBe('second');
  });

  it('preserves all event fields (sessionId, catId, etc.)', () => {
    const threadEvents = new Map([['t1', [makeRaw('t1', 1000, 0, { catId: 'codex', sessionId: 's-custom' })]]]);
    const merged = mergeFeatureEvents(threadEvents);
    expect(merged[0].catId).toBe('codex');
    expect(merged[0].sessionId).toBe('s-custom');
  });
});
