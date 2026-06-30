/**
 * F252 Phase A — Replay Engine Regression & Advanced Tests
 *
 * Cloud review regression tests, log compression wiring, MAX speed,
 * and elapsed time clamping. Core state machine tests are in replay-engine.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { compressEventTimestamps, createReplayEngine, play, seek, setSpeed, tick } from '../replay-engine';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers (shared with replay-engine.test.ts)
// ---------------------------------------------------------------------------

function makeReplayEvents(count: number, gapMs = 1000): ReplayEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    type: 'message' as const,
    timestamp: 1000 + i * gapMs,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Event ${i}`,
    eventNo: i + 1,
  }));
}

// ---------------------------------------------------------------------------
// P1-2 regression: seek then play must not jump to end (R1 review)
// ---------------------------------------------------------------------------

describe('F252 replay engine — seek then play (P1-2 regression)', () => {
  it('continues playback correctly after seek to middle', () => {
    const events = makeReplayEvents(5, 1000);
    let engine = play(createReplayEngine(events));

    engine = seek(engine, 2);
    expect(engine.currentIndex).toBe(2);

    engine = play(engine);
    engine = tick(engine, 1);
    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(2);
  });

  it('seek does not cause immediate end on next tick', () => {
    const events = makeReplayEvents(3, 10000);
    let engine = play(createReplayEngine(events));

    engine = seek(engine, 1);
    engine = play(engine);
    engine = tick(engine, 10);
    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cloud R1: seek from ended state (P2-4)
// ---------------------------------------------------------------------------

describe('F252 engine — seek from ended transitions to paused (cloud P2-4)', () => {
  it('transitions from ended to paused when seeking to non-final event', () => {
    const events = makeReplayEvents(5, 1000);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = tick(engine, 1000);
    expect(engine.state).toBe('ended');

    engine = seek(engine, 2);
    expect(engine.state).toBe('paused');
    expect(engine.currentIndex).toBe(2);
  });

  it('stays ended when seeking to the last event from ended', () => {
    const events = makeReplayEvents(5, 1000);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = tick(engine, 1000);
    expect(engine.state).toBe('ended');

    engine = seek(engine, 4);
    expect(engine.state).toBe('ended');
    expect(engine.currentIndex).toBe(4);
  });

  it('can resume playing after seek-from-ended', () => {
    const events = makeReplayEvents(5, 1000);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = tick(engine, 1000);
    expect(engine.state).toBe('ended');

    engine = seek(engine, 1);
    expect(engine.state).toBe('paused');

    engine = play(engine);
    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cloud R1: log compression wired into timestamps (P2-3 + gpt52 P1)
// ---------------------------------------------------------------------------

describe('F252 engine — compressEventTimestamps (cloud P2-3 + gpt52 P1)', () => {
  it('compresses large gaps AFTER tool_call events (tool wait)', () => {
    const events: ReplayEvent[] = [
      { index: 0, type: 'tool_call', timestamp: 1000, role: 'assistant', content: '', eventNo: 1 },
      { index: 1, type: 'message', timestamp: 61000, role: 'assistant', content: '', eventNo: 2 },
    ];

    const compressed = compressEventTimestamps(events);
    const gap = compressed[1].timestamp - compressed[0].timestamp;

    expect(gap).toBeGreaterThan(5000);
    expect(gap).toBeLessThan(10000);
    expect(gap).toBeLessThan(60000);
  });

  it('does NOT compress gaps between non-tool events (gpt52 P1 regression)', () => {
    const events: ReplayEvent[] = [
      { index: 0, type: 'message', timestamp: 1000, role: 'user', content: '', eventNo: 1 },
      { index: 1, type: 'message', timestamp: 61000, role: 'assistant', content: '', eventNo: 2 },
    ];

    const compressed = compressEventTimestamps(events);
    const gap = compressed[1].timestamp - compressed[0].timestamp;

    expect(gap).toBe(60000);
  });

  it('compresses gap between consecutive tool_calls', () => {
    const events: ReplayEvent[] = [
      { index: 0, type: 'tool_call', timestamp: 1000, role: 'assistant', content: '', eventNo: 1 },
      { index: 1, type: 'tool_call', timestamp: 601000, role: 'assistant', content: '', eventNo: 2 },
    ];

    const compressed = compressEventTimestamps(events);
    const gap = compressed[1].timestamp - compressed[0].timestamp;

    expect(gap).toBeGreaterThan(10000);
    expect(gap).toBeLessThan(15000);
  });

  it('preserves short tool-adjacent gaps unchanged', () => {
    const events: ReplayEvent[] = [
      { index: 0, type: 'tool_call', timestamp: 1000, role: 'assistant', content: '', eventNo: 1 },
      { index: 1, type: 'message', timestamp: 1500, role: 'assistant', content: '', eventNo: 2 },
    ];

    const compressed = compressEventTimestamps(events);
    const gap = compressed[1].timestamp - compressed[0].timestamp;

    expect(gap).toBe(500);
  });

  it('returns same array for single event', () => {
    const events: ReplayEvent[] = [
      { index: 0, type: 'message', timestamp: 1000, role: 'user', content: '', eventNo: 1 },
    ];
    const compressed = compressEventTimestamps(events);

    expect(compressed).toHaveLength(1);
    expect(compressed[0].timestamp).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Cloud R4: MAX speed one-event-per-tick (P2-3)
// ---------------------------------------------------------------------------

describe('F252 replay engine — MAX speed advances one event per tick', () => {
  it('advances exactly one event per tick in MAX mode', () => {
    const events = makeReplayEvents(5, 10000);
    let engine = play(createReplayEngine(events));
    engine = setSpeed(engine, 'max');

    engine = tick(engine, 16);
    expect(engine.currentIndex).toBe(1);
    expect(engine.state).toBe('playing');
  });

  it('reaches ended after N ticks for N events', () => {
    const events = makeReplayEvents(4, 5000);
    let engine = play(createReplayEngine(events));
    engine = setSpeed(engine, 'max');

    engine = tick(engine, 16);
    engine = tick(engine, 16);
    engine = tick(engine, 16);
    expect(engine.currentIndex).toBe(3);
    expect(engine.state).toBe('ended');
  });
});

// ---------------------------------------------------------------------------
// Cloud R4: elapsed time clamping at end (P2-4)
// ---------------------------------------------------------------------------

describe('F252 replay engine — elapsed time clamping', () => {
  it('clamps elapsedMs to totalDurationMs when ending playback', () => {
    const events = makeReplayEvents(3, 1000);
    let engine = play(createReplayEngine(events));
    engine = tick(engine, 100);
    expect(engine.state).toBe('ended');
    expect(engine.elapsedMs).toBe(2000);
  });
});
