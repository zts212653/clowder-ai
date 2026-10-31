/**
 * F252 Phase E — Bullet Time: Lifecycle & Exit Conditions
 *
 * Tests duration-based exit, ended-state clearing, consecutive triggers,
 * pause/play preservation, and MAX speed interactions.
 * Split from bullet-time-engine.test.ts (opus-47 P2: 552 > 350 limit).
 *
 * Covers: duration exit, 対抗1 (ended), 対抗2 (consecutive),
 *         対抗5 (pause/play), tickMax ended/non-ending.
 */

import { describe, expect, it } from 'vitest';
import { BULLET_TIME_TOTAL_MS } from '../bullet-time';
import { createReplayEngine, pause, play, setSpeed, tick } from '../replay-engine';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal event array with configurable pass-ball flags */
function makeEvents(specs: Array<{ t: number; isPassBall?: boolean }>): ReplayEvent[] {
  return specs.map((s, i) => ({
    index: i,
    type: 'message' as const,
    timestamp: s.t,
    role: 'assistant',
    content: `msg-${i}`,
    eventNo: i,
    isPassBall: s.isPassBall,
  }));
}

/** Advance engine by deltaMs, returning new state */
function tickBy(state: ReturnType<typeof createReplayEngine>, ms: number) {
  return tick(state, ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F252 bullet time — lifecycle & exit conditions', () => {
  // ── Transition: progressMs >= TOTAL → exits ──

  it('exits bullet time after total duration elapses', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true },
      { t: 100_000 }, // far away so engine doesn't end
    ]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Enter bullet time
    engine = tickBy(engine, 16);
    expect(engine.bulletTime).not.toBeNull();

    // Tick through the full bullet time duration
    // Each tick advances progressMs by deltaMs (real time, not scaled)
    let totalTicked = 0;
    while (engine.bulletTime && totalTicked < BULLET_TIME_TOTAL_MS + 1000) {
      engine = tickBy(engine, 50);
      totalTicked += 50;
    }

    expect(engine.bulletTime).toBeNull();
    expect(totalTicked).toBeLessThanOrEqual(BULLET_TIME_TOTAL_MS + 100); // exits near total
  });

  // ── 対抗1: pass-ball at last event → engine ends ──

  it('対抗1: clears bullet time when engine reaches ended state', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true }, // last event is pass-ball
    ]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Tick to pass-ball (which is the last event)
    engine = tickBy(engine, 16);

    // Engine should be ended (only 2 events, pass-ball is last)
    // Whether bullet time is set or not, ended state should clear it
    if (engine.state === 'ended') {
      expect(engine.bulletTime).toBeNull();
    }
    // If not ended yet, tick more
    for (let i = 0; i < 100 && engine.state !== 'ended'; i++) {
      engine = tickBy(engine, 50);
    }
    expect(engine.state).toBe('ended');
    expect(engine.bulletTime).toBeNull();
  });

  // ── 対抗2: two consecutive pass-ball events → restart ──

  it('対抗2: restarts bullet time on second consecutive pass-ball', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 400, isPassBall: true }, { t: 100_000 }]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Tick to first pass-ball
    engine = tickBy(engine, 16);
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(1);

    // Tick through bullet time until engine advances past first pass-ball
    // and hits second pass-ball
    for (let i = 0; i < 200; i++) {
      engine = tickBy(engine, 50);
      if (engine.bulletTime && engine.bulletTime.triggerIndex === 2) break;
    }

    // Should have restarted bullet time for second pass-ball
    if (engine.currentIndex >= 2) {
      expect(engine.bulletTime).not.toBeNull();
      expect(engine.bulletTime!.triggerIndex).toBe(2);
    }
  });

  // ── 対抗5: pause during bullet time → preserves ──

  it('対抗5: preserves bullet time state across pause/play', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 100_000 }]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Enter bullet time
    engine = tickBy(engine, 16);
    expect(engine.bulletTime).not.toBeNull();
    const btBefore = engine.bulletTime!;

    // Pause
    engine = pause(engine);
    expect(engine.state).toBe('paused');
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.progressMs).toBe(btBefore.progressMs);

    // Play again
    engine = play(engine);
    expect(engine.state).toBe('playing');
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.progressMs).toBe(btBefore.progressMs);
  });

  // ── Audit: tickMax clears bulletTime on ended (R2 P2 review fix) ──

  it('INV-5/tickMax: clears bulletTime when speed=MAX reaches ended', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true },
      { t: 400 },
      { t: 100_000 }, // far enough that normal tick enters bullet time first
    ]);
    let engine = play(createReplayEngine(events));

    // Tick at normal speed until bullet time activates
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();

    // Switch to MAX speed — tickMax should clear bulletTime when reaching ended
    engine = setSpeed(engine, 'max');

    // Tick with MAX — each tick advances one event
    for (let i = 0; i < 10 && engine.state !== 'ended'; i++) {
      engine = tickBy(engine, 16);
    }

    expect(engine.state).toBe('ended');
    expect(engine.bulletTime).toBeNull(); // INV-5: ended → no bullet time
  });

  // ── Cloud R2: tickMax non-ending path clears stale bulletTime ──

  it('tickMax non-ending: clears bulletTime when MAX advances without reaching ended', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true }, // trigger at index 1
      { t: 400 },
      { t: 600 },
      { t: 800 },
      { t: 100_000 }, // far enough to not end quickly
    ]);
    let engine = play(createReplayEngine(events));

    // Tick at normal speed until bullet time activates at event 1
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(1);

    // Switch to MAX — one tick should advance to event 2 (non-ending) and clear stale bulletTime
    engine = setSpeed(engine, 'max');
    engine = tickBy(engine, 16);

    // Should have advanced past trigger but NOT ended (6 events, at most index 2)
    expect(engine.currentIndex).toBeGreaterThan(1);
    expect(engine.state).not.toBe('ended');
    // Stale bulletTime from event 1 must be cleared
    expect(engine.bulletTime).toBeNull();
  });
});
