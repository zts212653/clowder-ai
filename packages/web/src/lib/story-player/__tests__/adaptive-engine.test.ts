/**
 * F252 Phase B — Engine Integration with Adaptive Pacing (AC-B1)
 *
 * Tests for pass-ball slowdown during tick + adaptive pacing toggle.
 * The replay engine's tick() should reduce effective speed at pass-ball events
 * when adaptive pacing is enabled.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIP_DISPLAY_MS } from '../adaptive-pacing';
import {
  createReplayEngine,
  PASS_BALL_SLOWDOWN_FACTOR,
  play,
  seek,
  setSpeed,
  tick,
  toggleAdaptivePacing,
} from '../replay-engine';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ReplayEvent> & { timestamp: number }): ReplayEvent {
  return {
    index: 0,
    type: 'message',
    role: 'assistant',
    content: '',
    eventNo: 0,
    ...overrides,
  };
}

/**
 * Create events for engine tests with explicit pass-ball annotation.
 * Events are evenly spaced at 10s intervals.
 */
function makeEngineEvents(count: number, passBallIndices: number[] = []): ReplayEvent[] {
  const passBallSet = new Set(passBallIndices);
  return Array.from({ length: count }, (_, i) =>
    makeEvent({
      index: i,
      timestamp: i * 10_000, // 10s apart
      eventNo: i,
      isPassBall: passBallSet.has(i) || undefined,
    }),
  );
}

// ==========================================================================
// § 1  Engine creation with adaptive pacing
// ==========================================================================

describe('F252 engine — adaptive pacing mode', () => {
  it('creates engine with adaptivePacing enabled by default', () => {
    const events = makeEngineEvents(5);
    const engine = createReplayEngine(events);
    expect(engine.adaptivePacing).toBe(true);
  });

  it('toggleAdaptivePacing switches mode', () => {
    const events = makeEngineEvents(5);
    const engine = createReplayEngine(events);
    expect(engine.adaptivePacing).toBe(true);

    const toggled = toggleAdaptivePacing(engine);
    expect(toggled.adaptivePacing).toBe(false);

    const toggledBack = toggleAdaptivePacing(toggled);
    expect(toggledBack.adaptivePacing).toBe(true);
  });

  it('PASS_BALL_SLOWDOWN_FACTOR is exported and > 1', () => {
    expect(PASS_BALL_SLOWDOWN_FACTOR).toBeGreaterThan(1);
  });
});

// ==========================================================================
// § 2  Pass-ball slowdown during tick
// ==========================================================================

describe('F252 engine — pass-ball slowdown in tick', () => {
  it('advances slower at pass-ball events when adaptive pacing is on', () => {
    // Events: 0s, 10s, 20s. Event[1] is pass-ball.
    // At 100x speed, 100ms real delta = 10_000ms playback delta (normal)
    // With bullet time easing: first tick lands on pass-ball marker → enters bullet time.
    // Second tick applies easing curve: speedFactor < 1.0 → slower advance.
    const events = makeEngineEvents(3, [1]);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    // Tick 1: start at event 0, advance 100ms real time
    // Normal: elapsed += 100 * 100 = 10_000 → reaches event 1 (pass-ball marker stop)
    const after1 = tick(engine, 100);
    expect(after1.currentIndex).toBe(1); // reached pass-ball event
    expect(after1.bulletTime).not.toBeNull(); // bullet time entered

    // Tick 2: now in bullet time → easing curve applies speedFactor < 1.0
    const after2 = tick(after1, 100);
    expect(after2.currentIndex).toBe(1); // still at event 1 (slowed down)
    // Verify elapsed advanced less than full speed (100 * 100 = 10000)
    const advance = after2.elapsedMs - after1.elapsedMs;
    expect(advance).toBeLessThan(100 * 100); // slower than normal
    expect(advance).toBeGreaterThan(0); // but still advancing
  });

  it('does NOT slow down when adaptive pacing is off', () => {
    const events = makeEngineEvents(3, [1]);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);
    engine = toggleAdaptivePacing(engine); // turn off adaptive

    // Tick to reach event 1
    const after1 = tick(engine, 100);
    expect(after1.currentIndex).toBe(1);

    // Tick again — no slowdown, full speed
    const after2 = tick(after1, 100);
    // elapsed = 10_000 + 100*100 = 20_000 → reaches event 2 at t=20_000
    expect(after2.currentIndex).toBe(2);
  });

  it('does NOT slow down at non-pass-ball events', () => {
    const events = makeEngineEvents(3); // no pass-ball events
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    const after1 = tick(engine, 100);
    expect(after1.currentIndex).toBe(1);

    // Full speed at event 1 (not pass-ball)
    const after2 = tick(after1, 100);
    expect(after2.currentIndex).toBe(2);
  });

  it('applies bullet time easing at pass-ball events even at low speed', () => {
    // At 1x speed with bullet time: easing curve applies speedFactor (0.01 at hold phase)
    // This is intentionally slower than 1x — the easing creates a dramatic pause.
    const events = makeEngineEvents(3, [1]);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 1);

    // Tick past event 0 to reach event 1
    // At 1x: 100ms real = 100ms playback. Need 10_000ms to reach event 1.
    let state = engine;
    for (let i = 0; i < 100; i++) state = tick(state, 100); // 10s real time
    expect(state.currentIndex).toBe(1);
    expect(state.bulletTime).not.toBeNull(); // bullet time entered

    // Now at pass-ball with bullet time active. Speed factor < 1.0
    const before = state.elapsedMs;
    const after = tick(state, 100);
    // At 1x base speed with easing, effective speed < 1.0
    const advance = after.elapsedMs - before;
    expect(advance).toBeLessThan(100 * 1); // slower than normal 1x
    expect(advance).toBeGreaterThan(0); // but still advancing
  });

  it('stops at pass-ball marker instead of skipping past it at high speed', () => {
    // Events: 0ms, 1000ms (pass-ball), 1100ms — densely spaced after compression
    // At 100x speed, 16ms tick → 1600ms advance → would skip past both events
    const events = [
      makeEvent({ index: 0, timestamp: 0, eventNo: 0 }),
      makeEvent({ index: 1, timestamp: 1000, eventNo: 1, isPassBall: true }),
      makeEvent({ index: 2, timestamp: 1100, eventNo: 2 }),
    ];
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    // Single tick of 16ms at 100x = 1600ms → would normally reach event[2] at t=1100
    // But should STOP at event[1] (pass-ball marker) so slowdown can fire
    const after = tick(engine, 16);
    expect(after.currentIndex).toBe(1); // stopped at pass-ball, not jumped to 2
  });

  it('stops at idle-gap marker instead of skipping past it at high speed', () => {
    // After adaptive compression, idle gap becomes 500ms (DEFAULT_SKIP_DISPLAY_MS)
    // Events: 0ms, 500ms (idle marker), 600ms
    const events = [
      makeEvent({ index: 0, timestamp: 0, eventNo: 0 }),
      makeEvent({ index: 1, timestamp: 500, eventNo: 1, idleSkipMs: 600_000 }),
      makeEvent({ index: 2, timestamp: 600, eventNo: 2 }),
    ];
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    // 16ms tick at 100x = 1600ms → would reach event[2]. But should stop at idle marker
    const after = tick(engine, 16);
    expect(after.currentIndex).toBe(1); // stopped at idle marker for banner display
  });

  it('does NOT stop at markers when adaptive pacing is OFF', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 0, eventNo: 0 }),
      makeEvent({ index: 1, timestamp: 1000, eventNo: 1, isPassBall: true }),
      makeEvent({ index: 2, timestamp: 1100, eventNo: 2 }),
    ];
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);
    engine = toggleAdaptivePacing(engine); // OFF

    // With adaptive OFF, no marker stopping — normal advancement
    const after = tick(engine, 16);
    expect(after.currentIndex).toBe(2); // jumps past both
  });

  it('does NOT apply slowdown in MAX mode', () => {
    // MAX mode should be unaffected by pass-ball — it always advances one event per tick
    const events = makeEngineEvents(5, [1, 2, 3]);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 'max');

    // Each tick should advance exactly one event regardless of pass-ball
    const after1 = tick(engine, 16);
    expect(after1.currentIndex).toBe(1); // pass-ball event, but MAX → advance

    const after2 = tick(after1, 16);
    expect(after2.currentIndex).toBe(2); // pass-ball event, but MAX → advance

    const after3 = tick(after2, 16);
    expect(after3.currentIndex).toBe(3); // pass-ball event, but MAX → advance
  });
});

// ==========================================================================
// § 3  Existing tests still pass (no regression)
// ==========================================================================

describe('F252 engine — adaptive pacing does not break existing behavior', () => {
  it('creates engine with correct initial state including adaptivePacing', () => {
    const events = makeEngineEvents(5);
    const engine = createReplayEngine(events);

    expect(engine.state).toBe('idle');
    expect(engine.speed).toBe(100);
    expect(engine.currentIndex).toBe(0);
    expect(engine.totalEvents).toBe(5);
    expect(engine.displayMode).toBe('cinematic');
    expect(engine.adaptivePacing).toBe(true);
  });

  it('tick works normally without pass-ball events when adaptive is on', () => {
    const events = makeEngineEvents(3);
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    // Normal advancement: 100ms * 100x = 10_000ms → event 1
    const after = tick(engine, 100);
    expect(after.currentIndex).toBe(1);
    expect(after.elapsedMs).toBe(10_000);
  });
});

// ==========================================================================
// § 4  Idle gap dynamic handling (P1-1 fix)
// ==========================================================================

describe('F252 engine — idle gap dynamic handling', () => {
  it('totalDurationMs uses effective duration when adaptive is ON', () => {
    const events = [
      makeEvent({ timestamp: 0 }),
      makeEvent({ timestamp: 30_000 }),
      makeEvent({ timestamp: 630_001, idleSkipMs: 600_001 }),
    ];
    const engine = createReplayEngine(events);
    // adaptive ON: effective = 30000 + DEFAULT_SKIP_DISPLAY_MS
    expect(engine.totalDurationMs).toBe(30_000 + DEFAULT_SKIP_DISPLAY_MS);
  });

  it('toggleAdaptivePacing recomputes totalDurationMs to raw when OFF', () => {
    const events = [makeEvent({ timestamp: 0 }), makeEvent({ timestamp: 630_001, idleSkipMs: 630_001 })];
    let engine = createReplayEngine(events);
    expect(engine.totalDurationMs).toBe(DEFAULT_SKIP_DISPLAY_MS);

    engine = toggleAdaptivePacing(engine);
    expect(engine.totalDurationMs).toBe(630_001);
  });

  it('when adaptive ON, tick warps past idle gaps using display beat', () => {
    const events = [makeEvent({ timestamp: 0 }), makeEvent({ timestamp: 600_001, idleSkipMs: 600_001 })];
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);

    // Effective gap = 500ms. At 100x, 10ms wall = 1000ms effective > 500ms → advance
    engine = tick(engine, 10);
    expect(engine.currentIndex).toBe(1);
  });

  it('when adaptive OFF, tick traverses idle gaps at full duration', () => {
    const events = [makeEvent({ timestamp: 0 }), makeEvent({ timestamp: 600_001, idleSkipMs: 600_001 })];
    let engine = createReplayEngine(events);
    engine = play(engine);
    engine = setSpeed(engine, 100);
    engine = toggleAdaptivePacing(engine); // OFF

    // Raw gap = 600001ms. At 100x, 10ms wall = 1000ms. Not enough.
    engine = tick(engine, 10);
    expect(engine.currentIndex).toBe(0);
  });

  it('seek computes elapsedMs using effective offset when adaptive ON', () => {
    const events = [
      makeEvent({ timestamp: 0 }),
      makeEvent({ timestamp: 30_000 }),
      makeEvent({ timestamp: 630_000, idleSkipMs: 600_000 }),
    ];
    let engine = createReplayEngine(events);
    engine = seek(engine, 2);

    // Effective offset at index 2: 30000 + 500 = 30500
    expect(engine.elapsedMs).toBe(30_000 + DEFAULT_SKIP_DISPLAY_MS);
  });

  it('toggle preserves position while changing elapsed/total', () => {
    const events = [
      makeEvent({ timestamp: 0 }),
      makeEvent({ timestamp: 30_000 }),
      makeEvent({ timestamp: 630_000, idleSkipMs: 600_000 }),
      makeEvent({ timestamp: 660_000 }),
    ];
    let engine = createReplayEngine(events);
    engine = seek(engine, 1); // move to event 1

    engine = toggleAdaptivePacing(engine); // OFF
    expect(engine.currentIndex).toBe(1);
    expect(engine.elapsedMs).toBe(30_000); // raw offset at index 1
    expect(engine.totalDurationMs).toBe(660_000); // raw total
  });
});
