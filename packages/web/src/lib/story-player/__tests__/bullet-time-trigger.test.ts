/**
 * F252 Phase E — Bullet Time: Trigger & Entry Conditions
 *
 * Tests entry conditions and core invariants for bullet time activation.
 * Split from bullet-time-engine.test.ts (opus-47 P2: 552 > 350 limit).
 *
 * Covers: INV-1 (progressMs >= 0), INV-2 (triggerIndex valid),
 *         INV-4 (null when adaptive off), INV-5 (null on idle),
 *         toggle clear/no-resume, speed verification.
 */

import { describe, expect, it } from 'vitest';
import { createReplayEngine, play, tick, toggleAdaptivePacing } from '../replay-engine';
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

describe('F252 bullet time — trigger & entry conditions', () => {
  // ── INV-5: idle/ended → no bullet time ──

  it('INV-5: createReplayEngine starts with bulletTime=null', () => {
    const events = makeEvents([{ t: 0 }, { t: 1000 }, { t: 2000 }]);
    const engine = createReplayEngine(events);
    expect(engine.bulletTime).toBeNull();
  });

  // ── Transition: tick hits pass-ball → enters bullet time ──

  it('enters bullet time when tick advances to a pass-ball event', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 100 }, // normal
      { t: 200, isPassBall: true }, // pass-ball at index 2
      { t: 5000 },
    ]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Tick past event 1 and event 2 (pass-ball)
    // At 100× speed, 16ms real = 1600ms virtual → should reach event 2 (t=200)
    engine = tickBy(engine, 16);

    // Engine should be at or past the pass-ball event
    expect(engine.currentIndex).toBeGreaterThanOrEqual(2);
    // Bullet time should be active
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(2);
  });

  // ── INV-4: no effect when adaptive off ──

  it('INV-4: does not enter bullet time when adaptivePacing=false', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 5000 }]);
    let engine = createReplayEngine(events);
    engine = toggleAdaptivePacing(engine); // turn OFF
    expect(engine.adaptivePacing).toBe(false);
    engine = play(engine);

    // Tick past pass-ball event
    engine = tickBy(engine, 16);

    expect(engine.bulletTime).toBeNull();
  });

  // ── P2 fix: toggleAdaptivePacing clears stale bullet time ──

  it('clears bulletTime when adaptive pacing is toggled OFF', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 100_000 }]);
    let engine = play(createReplayEngine(events));

    // Tick until bullet time activates
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();

    // Toggle adaptive OFF → bulletTime must be cleared
    engine = toggleAdaptivePacing(engine);
    expect(engine.adaptivePacing).toBe(false);
    expect(engine.bulletTime).toBeNull();
  });

  it('does not resume stale bullet time when adaptive pacing is toggled back ON', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 500 }, { t: 1000 }, { t: 100_000 }]);
    let engine = play(createReplayEngine(events));

    // Tick until bullet time activates at event 1
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(1);

    // Toggle OFF → tick forward past the pass-ball → toggle ON
    engine = toggleAdaptivePacing(engine);
    expect(engine.bulletTime).toBeNull();

    // Tick forward with adaptive off (no slowdown)
    for (let i = 0; i < 100; i++) {
      engine = tickBy(engine, 16);
    }

    // Toggle back ON — should not have stale bullet time
    engine = toggleAdaptivePacing(engine);
    expect(engine.adaptivePacing).toBe(true);
    expect(engine.bulletTime).toBeNull();
  });

  // ── INV-2: triggerIndex references valid pass-ball event ──

  it('INV-2: bulletTime.triggerIndex always points to a pass-ball event', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 100 },
      { t: 200, isPassBall: true },
      { t: 300 },
      { t: 400, isPassBall: true },
      { t: 100_000 },
    ]);
    let engine = play(createReplayEngine(events));

    // Tick through and verify every time bulletTime is set
    for (let i = 0; i < 500; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) {
        const idx = engine.bulletTime.triggerIndex;
        expect(events[idx].isPassBall).toBe(true);
      }
      if (engine.state === 'ended') break;
    }
  });

  // ── INV-1: progressMs >= 0 ──

  it('INV-1: bulletTime.progressMs is always >= 0', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 100_000 }]);
    let engine = play(createReplayEngine(events));

    for (let i = 0; i < 200; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) {
        expect(engine.bulletTime.progressMs).toBeGreaterThanOrEqual(0);
      }
      if (engine.state === 'ended') break;
    }
  });

  // ── Speed verification ──

  it('advances fewer events during bullet time than normal playback', () => {
    // Two identical event sequences, one with pass-ball, one without
    const withPassBall = makeEvents([
      { t: 0 },
      { t: 100, isPassBall: true },
      { t: 200 },
      { t: 300 },
      { t: 400 },
      { t: 500 },
      { t: 600 },
      { t: 700 },
      { t: 800 },
      { t: 900 },
    ]);
    const withoutPassBall = makeEvents([
      { t: 0 },
      { t: 100 },
      { t: 200 },
      { t: 300 },
      { t: 400 },
      { t: 500 },
      { t: 600 },
      { t: 700 },
      { t: 800 },
      { t: 900 },
    ]);

    let engWithBT = play(createReplayEngine(withPassBall));
    let engNoBT = play(createReplayEngine(withoutPassBall));

    // Tick both for same real time
    for (let i = 0; i < 20; i++) {
      engWithBT = tickBy(engWithBT, 16);
      engNoBT = tickBy(engNoBT, 16);
    }

    // Engine with bullet time should be behind (slower progress)
    expect(engWithBT.currentIndex).toBeLessThanOrEqual(engNoBT.currentIndex);
  });
});
