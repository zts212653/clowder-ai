/**
 * F252 Phase E PR E-4 — Active Thread Tracker Tests
 *
 * AC-E5 + AC-E3: Detect active threads at a given playback position
 * to drive multi-cam layout and spotlight/dim visual state.
 */
import { describe, expect, it } from 'vitest';
import { detectActiveThreads } from '../active-thread-tracker';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(index: number, sourceThreadId: string, timestamp: number): ReplayEvent {
  return {
    index,
    type: 'message',
    timestamp,
    role: 'assistant',
    content: `msg-${index}`,
    eventNo: index,
    sourceThreadId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectActiveThreads', () => {
  const events: ReplayEvent[] = [
    makeEvent(0, 't1', 1000),
    makeEvent(1, 't1', 2000),
    makeEvent(2, 't2', 3000), // t2 becomes active
    makeEvent(3, 't1', 4000), // t1 still active
    makeEvent(4, 't2', 5000),
    makeEvent(5, 't3', 6000), // t3 joins
    makeEvent(6, 't1', 7000),
  ];

  it('spotlight is the current event source thread', () => {
    const result = detectActiveThreads(events, 2, 2000);
    expect(result.spotlightThreadId).toBe('t2');
  });

  it('active threads include those with events within window', () => {
    // At index 3 (t1, ts=4000), window=2000 → events at ts >= 2000
    // t1 has events at 2000, 4000; t2 has event at 3000 → both active
    const result = detectActiveThreads(events, 3, 2000);
    expect(result.activeThreadIds).toContain('t1');
    expect(result.activeThreadIds).toContain('t2');
    expect(result.activeThreadIds).not.toContain('t3');
  });

  it('returns single layout for one active thread', () => {
    const result = detectActiveThreads(events, 0, 500);
    expect(result.layout).toBe('single');
  });

  it('returns dual layout for two active threads', () => {
    const result = detectActiveThreads(events, 3, 2000);
    expect(result.layout).toBe('dual');
  });

  it('returns multi layout for three+ active threads', () => {
    // At index 6 (t1, ts=7000), window=5000 → events at ts >= 2000
    // All three threads have events in that window
    const result = detectActiveThreads(events, 6, 5000);
    expect(result.layout).toBe('multi');
  });

  it('handles empty events', () => {
    const result = detectActiveThreads([], 0, 2000);
    expect(result.activeThreadIds).toEqual([]);
    expect(result.spotlightThreadId).toBeNull();
    expect(result.layout).toBe('single');
  });

  it('handles out-of-bounds index', () => {
    const result = detectActiveThreads(events, 999, 2000);
    expect(result.spotlightThreadId).toBeNull();
  });

  it('handles negative index', () => {
    const result = detectActiveThreads(events, -1, 2000);
    expect(result.spotlightThreadId).toBeNull();
  });

  it('spotlight thread is always first in activeThreadIds', () => {
    const result = detectActiveThreads(events, 2, 2000);
    expect(result.activeThreadIds[0]).toBe(result.spotlightThreadId);
  });

  it('single-thread timeline stays single layout throughout', () => {
    const singleThreadEvents: ReplayEvent[] = [
      makeEvent(0, 't1', 1000),
      makeEvent(1, 't1', 2000),
      makeEvent(2, 't1', 3000),
    ];
    for (let i = 0; i < singleThreadEvents.length; i++) {
      const result = detectActiveThreads(singleThreadEvents, i, 2000);
      expect(result.layout).toBe('single');
      expect(result.spotlightThreadId).toBe('t1');
    }
  });

  it('uses default window of 30s when not specified', () => {
    // Events spread across 10s — all should be active with 30s default window
    const closeEvents: ReplayEvent[] = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 5000), makeEvent(2, 't3', 10000)];
    const result = detectActiveThreads(closeEvents, 2);
    expect(result.activeThreadIds).toHaveLength(3);
  });

  it('excludes threads outside the window', () => {
    // At index 6 (ts=7000), window=1000 → only events at ts >= 6000
    // t1 at 7000, t3 at 6000 → active; t2 last at 5000 → excluded
    const result = detectActiveThreads(events, 6, 1000);
    expect(result.activeThreadIds).toContain('t1');
    expect(result.activeThreadIds).toContain('t3');
    expect(result.activeThreadIds).not.toContain('t2');
    expect(result.layout).toBe('dual');
  });

  it('events without sourceThreadId are ignored', () => {
    const mixedEvents: ReplayEvent[] = [
      makeEvent(0, 't1', 1000),
      { index: 1, type: 'system', timestamp: 2000, role: 'system', content: '', eventNo: 1 }, // no sourceThreadId
      makeEvent(2, 't1', 3000),
    ];
    const result = detectActiveThreads(mixedEvents, 2, 5000);
    expect(result.activeThreadIds).toEqual(['t1']);
    expect(result.layout).toBe('single');
  });
});
