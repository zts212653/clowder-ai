/**
 * F252 Phase E — Bullet Time: Seek & Step Interactions
 *
 * Tests seek/stepForward/stepBackward behavior with active bullet time.
 * Split from bullet-time-engine.test.ts (opus-47 P2: 552 > 350 limit).
 *
 * Covers: seek exit/preserve, stepForward/stepBackward clear/clamp,
 *         R3 seek initialization (playing vs paused vs non-pass-ball).
 */

import { describe, expect, it } from 'vitest';
import { createReplayEngine, pause, play, seek, stepBackward, stepForward, tick } from '../replay-engine';
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

describe('F252 bullet time — seek & step interactions', () => {
  // ── Transition: seek during bullet time → exits ──

  it('exits bullet time on seek to different index', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 400 }, { t: 5000 }]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Tick to enter bullet time at event 1
    engine = tickBy(engine, 16);
    expect(engine.bulletTime).not.toBeNull();

    // Seek to a different event
    engine = seek(engine, 0);
    expect(engine.bulletTime).toBeNull();
  });

  it('preserves bullet time on seek to same trigger index', () => {
    const events = makeEvents([{ t: 0 }, { t: 200, isPassBall: true }, { t: 5000 }]);
    let engine = createReplayEngine(events);
    engine = play(engine);

    // Tick to enter bullet time at event 1
    engine = tickBy(engine, 16);
    expect(engine.bulletTime).not.toBeNull();
    const triggerIdx = engine.bulletTime!.triggerIndex;

    // Seek to the same trigger event
    engine = seek(engine, triggerIdx);
    expect(engine.bulletTime).not.toBeNull();
  });

  // ── Cloud R1: stepForward/stepBackward clear stale bulletTime ──

  it('clears bulletTime when stepForward moves away from trigger index', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true }, // trigger at index 1
      { t: 400 },
      { t: 100_000 },
    ]);
    let engine = play(createReplayEngine(events));

    // Tick until bullet time activates at event 1
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(1);

    // Step forward to event 2 — should clear stale bulletTime
    engine = stepForward(engine);
    expect(engine.currentIndex).toBe(2);
    expect(engine.bulletTime).toBeNull();
  });

  it('clears bulletTime when stepBackward moves away from trigger index', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 100 },
      { t: 200, isPassBall: true }, // trigger at index 2
      { t: 100_000 },
    ]);
    let engine = play(createReplayEngine(events));

    // Tick until bullet time activates at event 2
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(2);

    // Step backward to event 1 — should clear stale bulletTime
    engine = stepBackward(engine);
    expect(engine.currentIndex).toBe(1);
    expect(engine.bulletTime).toBeNull();
  });

  it('preserves bulletTime when stepForward stays at trigger index (clamped)', () => {
    // Only 2 events: trigger at last index, stepForward clamps to same
    const events = makeEvents([
      { t: 0 },
      { t: 200, isPassBall: true }, // trigger at index 1, also last
    ]);
    let engine = play(createReplayEngine(events));

    // Tick until bullet time activates
    for (let i = 0; i < 50; i++) {
      engine = tickBy(engine, 16);
      if (engine.bulletTime) break;
    }
    // If ended, bullet time is null — that's also correct (INV-5)
    if (engine.state !== 'ended' && engine.bulletTime) {
      const triggerIdx = engine.bulletTime.triggerIndex;
      // Step forward — clamps to same index (last event)
      engine = stepForward(engine);
      expect(engine.currentIndex).toBe(triggerIdx);
      expect(engine.bulletTime).not.toBeNull();
    }
  });

  // ── Cloud R3: seek → bulletTime initialization ──
  // Chapter markers call onSeek(ch.eventIndex) — when seeking to a pass-ball
  // event while playing with adaptive pacing, bulletTime must be initialized.

  it('seek to pass-ball while playing inits bulletTime', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200 },
      { t: 400, isPassBall: true }, // target at index 2
      { t: 600 },
      { t: 100_000 },
    ]);
    let engine = play(createReplayEngine(events));
    // Adaptive pacing is ON by default — seek to pass-ball event while playing
    engine = seek(engine, 2);

    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(2);
    expect(engine.bulletTime).not.toBeNull();
    expect(engine.bulletTime!.triggerIndex).toBe(2);
    expect(engine.bulletTime!.progressMs).toBe(0);
  });

  it('seek to pass-ball while paused does NOT init bulletTime', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200 },
      { t: 400, isPassBall: true }, // target at index 2
      { t: 600 },
      { t: 100_000 },
    ]);
    let engine = pause(play(createReplayEngine(events)));
    expect(engine.state).toBe('paused');

    // Seek to pass-ball while paused — should NOT init bulletTime
    engine = seek(engine, 2);

    expect(engine.state).toBe('paused');
    expect(engine.currentIndex).toBe(2);
    expect(engine.bulletTime).toBeNull();
  });

  it('seek to non-pass-ball while playing does NOT init bulletTime', () => {
    const events = makeEvents([
      { t: 0 },
      { t: 200 },
      { t: 400, isPassBall: true },
      { t: 600 }, // target at index 3 — NOT a pass-ball
      { t: 100_000 },
    ]);
    let engine = play(createReplayEngine(events));

    // Seek to non-pass-ball event while playing — should NOT init bulletTime
    engine = seek(engine, 3);

    expect(engine.state).toBe('playing');
    expect(engine.currentIndex).toBe(3);
    expect(engine.bulletTime).toBeNull();
  });
});
