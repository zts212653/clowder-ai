/**
 * F252 Story Player — Replay Engine
 *
 * Pure, immutable state machine for replay control.
 * No timers, no RAF — timing is driven externally (by useReplayEngine hook).
 * Every function takes current state and returns next state.
 *
 * State machine: idle → playing ⇄ paused → ended → (play resets to beginning)
 */

import { DEFAULT_SKIP_DISPLAY_MS } from './adaptive-pacing';
import { BULLET_TIME_TOTAL_MS, bulletTimeSpeedFactor } from './bullet-time';
import type { BulletTimeState, ReplayEngineState, ReplayEvent, SpeedMultiplier } from './types';

// ---------------------------------------------------------------------------
// Constants (AC-B1)
// ---------------------------------------------------------------------------

/**
 * @deprecated Replaced by bullet time smooth easing (AC-E4).
 * Kept for backward compatibility — no longer used in tick().
 */
export const PASS_BALL_SLOWDOWN_FACTOR = 5;

// ---------------------------------------------------------------------------
// Internal types + idle warp table (P1-1: dynamic idle gap handling)
// ---------------------------------------------------------------------------

type InternalState = ReplayEngineState & { _events: ReplayEvent[]; _idleWarps: number[] };

/** Pre-compute cumulative idle gap reductions. warp[i] = total ms removed up to event i. */
function computeIdleWarps(events: ReplayEvent[]): number[] {
  const w = [0];
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].timestamp - events[i - 1].timestamp;
    const cut = events[i].idleSkipMs != null ? Math.max(0, gap - DEFAULT_SKIP_DISPLAY_MS) : 0;
    w.push(w[i - 1] + cut);
  }
  return w;
}

function getEvents(state: ReplayEngineState): ReplayEvent[] {
  return (state as InternalState)._events;
}
function getWarps(state: ReplayEngineState): number[] {
  return (state as InternalState)._idleWarps;
}

/** Effective elapsed time to event `idx`, accounting for adaptive idle compression. */
function effOffset(state: ReplayEngineState, events: ReplayEvent[], idx: number): number {
  if (idx <= 0 || events.length === 0) return 0;
  const i = Math.min(idx, events.length - 1);
  const raw = events[i].timestamp - events[0].timestamp;
  return state.adaptivePacing ? raw - (getWarps(state)[i] ?? 0) : raw;
}

/** Effective total duration for the current adaptive state. */
function effTotal(state: ReplayEngineState, events: ReplayEvent[]): number {
  return effOffset(state, events, events.length - 1);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createReplayEngine(events: ReplayEvent[]): ReplayEngineState {
  const warps = computeIdleWarps(events);
  const base: InternalState = {
    state: 'idle',
    speed: 100,
    currentIndex: 0,
    totalEvents: events.length,
    elapsedMs: 0,
    totalDurationMs: 0,
    displayMode: 'cinematic',
    adaptivePacing: true,
    bulletTime: null,
    _events: events,
    _idleWarps: warps,
  };
  // totalDurationMs computed via effTotal (uses adaptivePacing=true + warps)
  base.totalDurationMs = effTotal(base, events);
  return base as ReplayEngineState;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function play(state: ReplayEngineState): ReplayEngineState {
  // From ended → reset to beginning (INV-5: clear bullet time)
  if (state.state === 'ended') {
    return { ...state, state: 'playing', currentIndex: 0, elapsedMs: 0, bulletTime: null };
  }
  return { ...state, state: 'playing' };
}

export function pause(state: ReplayEngineState): ReplayEngineState {
  if (state.state !== 'playing') return state;
  return { ...state, state: 'paused' };
}

// ---------------------------------------------------------------------------
// Speed control
// ---------------------------------------------------------------------------

export function setSpeed(state: ReplayEngineState, speed: SpeedMultiplier): ReplayEngineState {
  return { ...state, speed };
}

// ---------------------------------------------------------------------------
// Display mode
// ---------------------------------------------------------------------------

export function setDisplayMode(state: ReplayEngineState, mode: 'cinematic' | 'faithful'): ReplayEngineState {
  return { ...state, displayMode: mode };
}

// ---------------------------------------------------------------------------
// Adaptive pacing toggle (AC-B1)
// ---------------------------------------------------------------------------

export function toggleAdaptivePacing(state: ReplayEngineState): ReplayEngineState {
  const events = getEvents(state);
  const turningOff = state.adaptivePacing;
  const next = { ...state, adaptivePacing: !state.adaptivePacing };
  // Clear bullet time when adaptive pacing is turned OFF — prevents stale
  // slowdown from resuming at the wrong position when toggled back ON (P2 review fix)
  if (turningOff) {
    next.bulletTime = null;
  }
  // Recompute elapsed + total for the new adaptive state (preserves currentIndex)
  next.elapsedMs = effOffset(next, events, state.currentIndex);
  next.totalDurationMs = effTotal(next, events);
  return next;
}

// ---------------------------------------------------------------------------
// Tick (time advancement) — called by external timer (RAF / setInterval)
// ---------------------------------------------------------------------------

/** MAX speed: advance exactly one event per tick (instant forwarding, shows each event briefly). */
function tickMax(state: ReplayEngineState, events: ReplayEvent[]): ReplayEngineState {
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= events.length - 1) {
    // INV-5: clear bulletTime on ended (R2 P2 review fix)
    return {
      ...state,
      currentIndex: events.length - 1,
      elapsedMs: effTotal(state, events),
      state: 'ended',
      bulletTime: null,
    };
  }
  // Clear bullet time — MAX skips through events without slowdown;
  // preserving stale bulletTime would apply wrong speedFactor on speed switch-back
  return { ...state, currentIndex: nextIndex, elapsedMs: effOffset(state, events, nextIndex), bulletTime: null };
}

/**
 * Advance the engine by `deltaMs` of real-world time.
 * elapsedMs is in "effective timeline" space — idle gaps compressed when adaptive is ON.
 */
export function tick(state: ReplayEngineState, deltaMs: number): ReplayEngineState {
  if (state.state !== 'playing') return state;

  const events = getEvents(state);
  // INV-5 defense-in-depth: clear bulletTime on ended even with empty events
  if (events.length === 0) return { ...state, state: 'ended', bulletTime: null };

  if (state.speed === 'max') return tickMax(state, events);

  // AC-E4: Bullet time easing — smooth decel/hold/accel at pass-ball events
  // If already in bullet time from previous tick, advance progress and apply easing
  let bulletTimeNext: BulletTimeState | null = state.bulletTime;
  let speedFactor = 1.0;

  if (bulletTimeNext && state.adaptivePacing) {
    bulletTimeNext = { ...bulletTimeNext, progressMs: bulletTimeNext.progressMs + deltaMs };
    speedFactor = bulletTimeSpeedFactor(bulletTimeNext.progressMs);
    // Exit bullet time after total duration
    if (bulletTimeNext.progressMs >= BULLET_TIME_TOTAL_MS) {
      bulletTimeNext = null;
      speedFactor = 1.0;
    }
  }

  const effectiveSpeed = state.speed * speedFactor;
  const newElapsed = state.elapsedMs + deltaMs * effectiveSpeed;

  // Find the last event whose effective offset is <= newElapsed.
  // AC-B1: When adaptive pacing is ON, stop at marker events (pass-ball / idle-gap)
  // so they become currentEvent — enables slowdown and skip banner display.
  // Without this, a fast tick (e.g. 100x, 16ms RAF = 1600ms) jumps past compressed
  // gaps (500ms) and markers are never "current".
  let newIndex = state.currentIndex;
  for (let i = state.currentIndex + 1; i < events.length; i++) {
    const offset = effOffset(state, events, i);
    if (offset <= newElapsed) {
      newIndex = i;
      // Stop at adaptive markers — clamp elapsed to marker offset so next tick
      // starts HERE (with slowdown/banner), rather than already past it
      if (state.adaptivePacing && (events[i].isPassBall || events[i].idleSkipMs != null)) {
        // Enter bullet time when landing on a pass-ball marker
        if (events[i].isPassBall && (!bulletTimeNext || bulletTimeNext.triggerIndex !== i)) {
          bulletTimeNext = { triggerIndex: i, progressMs: 0 };
        }
        return { ...state, currentIndex: newIndex, elapsedMs: offset, bulletTime: bulletTimeNext };
      }
    } else {
      break;
    }
  }

  // Check if we've passed the last event (INV-5: clear bullet time on ended)
  const total = effTotal(state, events);
  if (newElapsed >= total) {
    return { ...state, currentIndex: events.length - 1, elapsedMs: total, state: 'ended', bulletTime: null };
  }

  return { ...state, currentIndex: newIndex, elapsedMs: newElapsed, bulletTime: bulletTimeNext };
}

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

export function seek(state: ReplayEngineState, targetIndex: number): ReplayEngineState {
  const events = getEvents(state);
  if (events.length === 0) return state;

  const clamped = Math.max(0, Math.min(targetIndex, events.length - 1));

  // When seeking from 'ended' to a non-final event, transition to 'paused'
  const newState = state.state === 'ended' && clamped < events.length - 1 ? 'paused' : state.state;

  // Preserve existing bullet time if seeking to same trigger;
  // initialize new bullet time if seeking to pass-ball while playing with adaptive pacing
  // (R3 P2 fix: chapter markers call onSeek(ch.eventIndex) — must enter bullet time)
  let bulletTime: BulletTimeState | null = null;
  if (state.bulletTime && state.bulletTime.triggerIndex === clamped) {
    bulletTime = state.bulletTime;
  } else if (newState === 'playing' && state.adaptivePacing && events[clamped]?.isPassBall) {
    bulletTime = { triggerIndex: clamped, progressMs: 0 };
  }

  return {
    ...state,
    state: newState,
    currentIndex: clamped,
    elapsedMs: effOffset(state, events, clamped),
    bulletTime,
  };
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

export function stepForward(state: ReplayEngineState): ReplayEngineState {
  const events = getEvents(state);
  if (events.length === 0) return state;

  const nextIndex = Math.min(state.currentIndex + 1, events.length - 1);
  // Clear bullet time unless staying at the same trigger event (same pattern as seek)
  const bulletTime = state.bulletTime && state.bulletTime.triggerIndex === nextIndex ? state.bulletTime : null;
  return {
    ...state,
    state: state.state === 'playing' ? 'paused' : state.state,
    currentIndex: nextIndex,
    elapsedMs: effOffset(state, events, nextIndex),
    bulletTime,
  };
}

export function stepBackward(state: ReplayEngineState): ReplayEngineState {
  const events = getEvents(state);
  if (events.length === 0) return state;

  const prevIndex = Math.max(state.currentIndex - 1, 0);
  // Clear bullet time unless staying at the same trigger event (same pattern as seek)
  const bulletTime = state.bulletTime && state.bulletTime.triggerIndex === prevIndex ? state.bulletTime : null;
  return {
    ...state,
    state: state.state === 'playing' ? 'paused' : state.state,
    currentIndex: prevIndex,
    elapsedMs: effOffset(state, events, prevIndex),
    bulletTime,
  };
}

// ---------------------------------------------------------------------------
// Log compression for tool call waits (AC-A2)
// ---------------------------------------------------------------------------

/**
 * Compute compressed display delay for a tool call wait.
 *
 * Uses logarithmic compression to preserve narrative pacing:
 *   10s → ~3s, 60s → ~6s, 600s → ~12s
 *
 * Formula: compressed = 1000 * ln(1 + originalMs/1000) * scaleFactor
 * where scaleFactor calibrated to hit the target points.
 *
 * Very short waits (< 1s) pass through unchanged.
 */
export function computeLogCompressedDelay(originalMs: number): number {
  if (originalMs <= 0) return 0;
  if (originalMs < 1000) return originalMs;

  // Calibration: we want ln(1 + 10) * scale ≈ 3
  // ln(11) ≈ 2.398, so scale ≈ 3000 / 2.398 ≈ 1251
  // Check: ln(1+60)*1251 ≈ ln(61)*1251 ≈ 4.111*1251 ≈ 5142 (close to 6000)
  // Check: ln(1+600)*1251 ≈ ln(601)*1251 ≈ 6.399*1251 ≈ 8001 (need adjustment)
  //
  // Better fit: use seconds as input unit
  // compressed_s = scaleFactor * ln(1 + original_s)
  // Target: ln(11)*s = 3 → s = 3/ln(11) = 1.251
  //         ln(61)*1.251 = 5.14 → want 6, adjust
  //
  // Two-parameter: compressed = a * ln(1 + original_s / b)
  // Fit: a * ln(1 + 10/b) = 3, a * ln(1 + 600/b) = 12
  // Ratio: ln(1+600/b) / ln(1+10/b) = 4
  // b=3: ln(201)/ln(4.33) = 5.303/1.466 = 3.62 (too low)
  // b=5: ln(121)/ln(3) = 4.796/1.099 = 4.36 (close!)
  // b=4: ln(151)/ln(3.5) = 5.017/1.253 = 4.005 ≈ 4 ✓
  // Then a = 3 / ln(1+10/4) = 3 / ln(3.5) = 3 / 1.253 = 2.394
  // Verify: 2.394 * ln(1+60/4) = 2.394 * ln(16) = 2.394 * 2.773 = 6.637 → close to 6
  // Verify: 2.394 * ln(1+600/4) = 2.394 * ln(151) = 2.394 * 5.017 = 12.01 ✓

  const originalSec = originalMs / 1000;
  const a = 2.394;
  const b = 4;
  const compressedSec = a * Math.log(1 + originalSec / b);
  return compressedSec * 1000;
}

/**
 * Compress inter-event timestamps using log compression (AC-A2).
 *
 * Only compresses gaps adjacent to tool_call events — these represent
 * tool wait times (e.g. npm install, API calls). Non-tool gaps (message→message,
 * thinking→message) are preserved to maintain conversational rhythm.
 *
 * Spec: "原始等待時間用 log 壓縮" under "Tool Call Renderer" (F252 line 98).
 *
 * Returns new array with compressed timestamps; original events are not mutated.
 */
export function compressEventTimestamps(events: ReplayEvent[]): ReplayEvent[] {
  if (events.length <= 1) return events;

  const result: ReplayEvent[] = [events[0]];
  let compressedTimestamp = events[0].timestamp;

  for (let i = 1; i < events.length; i++) {
    const rawGap = events[i].timestamp - events[i - 1].timestamp;
    // Only compress gaps where the preceding event is a tool_call (= tool wait)
    // or the current event is a tool_call following another tool_call
    const isToolWaitGap = events[i - 1].type === 'tool_call';
    const compressedGap = isToolWaitGap ? computeLogCompressedDelay(rawGap) : rawGap;
    compressedTimestamp += compressedGap;
    result.push({ ...events[i], timestamp: compressedTimestamp });
  }

  return result;
}
