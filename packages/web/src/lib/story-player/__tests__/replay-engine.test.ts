/**
 * F252 Phase A — Replay Engine Tests
 *
 * Core replay logic: state machine, speed control, seek, time calculations.
 * The engine is a pure data structure (no timers/RAF) — timing is driven
 * externally by the React hook, making it fully testable.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLogCompressedDelay,
  createReplayEngine,
  pause,
  play,
  seek,
  setDisplayMode,
  setSpeed,
  stepBackward,
  stepForward,
  tick,
} from '../replay-engine';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReplayEvents(count: number, gapMs = 1000): ReplayEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    type: 'message' as const,
    timestamp: 1000 + i * gapMs,
    role: 'assistant',
    content: `Message ${i}`,
    eventNo: i + 1,
  }));
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('F252 replay engine — state machine', () => {
  it('starts in idle state', () => {
    const events = makeReplayEvents(5);
    const engine = createReplayEngine(events);

    expect(engine.state).toBe('idle');
    expect(engine.currentIndex).toBe(0);
    expect(engine.speed).toBe(100);
    expect(engine.displayMode).toBe('cinematic');
  });

  it('transitions idle → playing on play()', () => {
    const engine = play(createReplayEngine(makeReplayEvents(5)));
    expect(engine.state).toBe('playing');
  });

  it('transitions playing → paused on pause()', () => {
    let engine = play(createReplayEngine(makeReplayEvents(5)));
    engine = pause(engine);
    expect(engine.state).toBe('paused');
  });

  it('transitions paused → playing on play()', () => {
    let engine = play(createReplayEngine(makeReplayEvents(5)));
    engine = pause(engine);
    engine = play(engine);
    expect(engine.state).toBe('playing');
  });

  it('transitions to ended when all events consumed', () => {
    const events = makeReplayEvents(2, 100);
    let engine = play(createReplayEngine(events));

    // Tick enough time to consume all events
    engine = tick(engine, 5000);
    expect(engine.state).toBe('ended');
    expect(engine.currentIndex).toBe(1); // last event index
  });

  it('play from ended resets to beginning', () => {
    const events = makeReplayEvents(2, 100);
    let engine = play(createReplayEngine(events));
    engine = tick(engine, 5000); // reach end
    expect(engine.state).toBe('ended');

    engine = play(engine);
    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(0);
    expect(engine.elapsedMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Speed control
// ---------------------------------------------------------------------------

describe('F252 replay engine — speed control', () => {
  it('defaults to 100x', () => {
    const engine = createReplayEngine(makeReplayEvents(5));
    expect(engine.speed).toBe(100);
  });

  it('changes speed with setSpeed()', () => {
    let engine = createReplayEngine(makeReplayEvents(5));
    engine = setSpeed(engine, 10);
    expect(engine.speed).toBe(10);
  });

  it('supports MAX speed', () => {
    let engine = createReplayEngine(makeReplayEvents(5));
    engine = setSpeed(engine, 'max');
    expect(engine.speed).toBe('max');
  });
});

// ---------------------------------------------------------------------------
// Tick (time advancement)
// ---------------------------------------------------------------------------

describe('F252 replay engine — tick', () => {
  it('advances currentIndex based on elapsed time and speed', () => {
    // Events at 1000, 2000, 3000 (1s gaps)
    const events = makeReplayEvents(3, 1000);
    let engine = play(createReplayEngine(events));

    // At 100x speed: 1s gap becomes 10ms real time
    // Tick 15ms → should advance past first gap (10ms) but not second
    engine = tick(engine, 15);
    expect(engine.currentIndex).toBe(1);
  });

  it('does not advance when paused', () => {
    const events = makeReplayEvents(3, 1000);
    let engine = play(createReplayEngine(events));
    engine = pause(engine);

    engine = tick(engine, 5000);
    expect(engine.currentIndex).toBe(0);
  });

  it('MAX speed jumps to next event instantly on each tick', () => {
    const events = makeReplayEvents(5, 10000);
    let engine = play(createReplayEngine(events));
    engine = setSpeed(engine, 'max');

    engine = tick(engine, 1); // single tick, any deltaMs
    expect(engine.currentIndex).toBeGreaterThan(0);
  });

  it('tracks elapsed playback time in original timeline units', () => {
    // Use large gaps so engine doesn't reach 'ended' too fast at 100x
    const events = makeReplayEvents(3, 100_000);
    let engine = play(createReplayEngine(events));

    // At 100x speed: 50ms real = 5000ms original time
    engine = tick(engine, 50);
    expect(engine.elapsedMs).toBe(5000);

    // Another 30ms real = 3000ms original → total 8000ms
    engine = tick(engine, 30);
    expect(engine.elapsedMs).toBe(8000);
  });

  it('calculates total original duration', () => {
    // Events at 1000, 2000, 3000 → total duration = 2000ms
    const events = makeReplayEvents(3, 1000);
    const engine = createReplayEngine(events);

    expect(engine.totalDurationMs).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

describe('F252 replay engine — seek', () => {
  it('jumps to specific event index', () => {
    const events = makeReplayEvents(10, 1000);
    let engine = play(createReplayEngine(events));

    engine = seek(engine, 5);
    expect(engine.currentIndex).toBe(5);
  });

  it('clamps to valid range', () => {
    const events = makeReplayEvents(5, 1000);
    let engine = createReplayEngine(events);

    engine = seek(engine, -1);
    expect(engine.currentIndex).toBe(0);

    engine = seek(engine, 100);
    expect(engine.currentIndex).toBe(4); // last valid index
  });

  it('updates elapsed time to match seek position', () => {
    // Events at 1000, 2000, 3000, 4000, 5000
    const events = makeReplayEvents(5, 1000);
    let engine = createReplayEngine(events);

    engine = seek(engine, 3);
    // Event at index 3 has timestamp 4000, first event at 1000 → 3000ms elapsed (in original time)
    expect(engine.elapsedMs).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Step forward/backward
// ---------------------------------------------------------------------------

describe('F252 replay engine — stepping', () => {
  it('stepForward advances by one event', () => {
    const events = makeReplayEvents(5);
    let engine = pause(play(createReplayEngine(events)));

    engine = stepForward(engine);
    expect(engine.currentIndex).toBe(1);

    engine = stepForward(engine);
    expect(engine.currentIndex).toBe(2);
  });

  it('stepForward at end stays at end', () => {
    const events = makeReplayEvents(3);
    let engine = createReplayEngine(events);
    engine = seek(engine, 2); // last event

    engine = stepForward(engine);
    expect(engine.currentIndex).toBe(2);
  });

  it('stepBackward goes back one event', () => {
    const events = makeReplayEvents(5);
    let engine = createReplayEngine(events);
    engine = seek(engine, 3);

    engine = stepBackward(engine);
    expect(engine.currentIndex).toBe(2);
  });

  it('stepBackward at beginning stays at 0', () => {
    const events = makeReplayEvents(5);
    const engine = stepBackward(createReplayEngine(events));
    expect(engine.currentIndex).toBe(0);
  });

  it('stepping pauses playback', () => {
    const events = makeReplayEvents(5);
    let engine = play(createReplayEngine(events));
    expect(engine.state).toBe('playing');

    engine = stepForward(engine);
    expect(engine.state).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// Display mode
// ---------------------------------------------------------------------------

describe('F252 replay engine — display mode', () => {
  it('defaults to cinematic', () => {
    const engine = createReplayEngine(makeReplayEvents(3));
    expect(engine.displayMode).toBe('cinematic');
  });

  it('can switch to faithful', () => {
    let engine = createReplayEngine(makeReplayEvents(3));
    engine = setDisplayMode(engine, 'faithful');
    expect(engine.displayMode).toBe('faithful');
  });
});

// ---------------------------------------------------------------------------
// Log compression for tool calls (AC-A2)
// ---------------------------------------------------------------------------

describe('F252 replay engine — log compression (AC-A2)', () => {
  it('compresses 10s tool wait to ~3s', () => {
    const compressed = computeLogCompressedDelay(10_000);
    expect(compressed).toBeCloseTo(3000, -2); // within 100ms
  });

  it('compresses 60s tool wait to ~6s (within 15%)', () => {
    const compressed = computeLogCompressedDelay(60_000);
    // Log compression is approximate; spec says "60s→6s" as guideline
    expect(compressed).toBeGreaterThan(5000);
    expect(compressed).toBeLessThan(7000);
  });

  it('compresses 600s tool wait to ~12s', () => {
    const compressed = computeLogCompressedDelay(600_000);
    expect(compressed).toBeCloseTo(12000, -2);
  });

  it('preserves very short waits (< 1s)', () => {
    const compressed = computeLogCompressedDelay(500);
    expect(compressed).toBe(500);
  });

  it('never returns negative', () => {
    expect(computeLogCompressedDelay(0)).toBe(0);
    expect(computeLogCompressedDelay(-100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('F252 replay engine — edge cases', () => {
  it('handles empty event list', () => {
    const engine = createReplayEngine([]);
    expect(engine.totalEvents).toBe(0);
    expect(engine.totalDurationMs).toBe(0);
  });

  it('handles single event', () => {
    const engine = createReplayEngine(makeReplayEvents(1));
    expect(engine.totalEvents).toBe(1);
    expect(engine.totalDurationMs).toBe(0); // single event = no duration
  });
});

// Regression, compression, MAX speed, and clamping tests moved to replay-engine-regression.test.ts
