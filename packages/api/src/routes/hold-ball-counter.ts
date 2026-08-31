/**
 * F167 Mode-Aware Hold Ball Counter
 *
 * Extracted from callback-hold-ball-routes.ts for structural clarity.
 * Two independent rolling-window counters:
 *   - Timer holds (wakeAfterMs): 3/hour — existing behavior
 *   - Command holds (wakeWhen):  5/hour — bounded admission for command-custody
 *
 * Each counter tracks per (threadId, catId) pair. State is process-local
 * (in-memory Map) — best-effort only. API restart resets both counters.
 *
 * Design rationale (eval:harness-ledger C5/C6 verdict + sol review):
 *   Timer holds = "wait and poll" → lower limit, higher misuse risk
 *   Command holds = self-grounded (command IS the wait condition) → higher limit
 *   Both bounded: command can't evade quota by mode-switching
 */

// ── Hold mode type ──────────────────────────────────────────────────────────

export const HOLD_MODE_TIMER = 'timer' as const;
export const HOLD_MODE_COMMAND = 'command' as const;
export type HoldMode = typeof HOLD_MODE_TIMER | typeof HOLD_MODE_COMMAND;

// ── Constants ───────────────────────────────────────────────────────────────

export const MAX_TIMER_HOLDS_PER_WINDOW = 3;
export const MAX_COMMAND_HOLDS_PER_WINDOW = 5;
export const HOLD_WINDOW_MS = 3_600_000;

/** @deprecated Use MAX_TIMER_HOLDS_PER_WINDOW — kept for backward compat */
export const MAX_HOLDS_PER_WINDOW = MAX_TIMER_HOLDS_PER_WINDOW;

// ── Internal state ──────────────────────────────────────────────────────────

interface CounterEntry {
  count: number;
  lastAt: number;
}

const timerHoldCounts = new Map<string, CounterEntry>();
const commandHoldCounts = new Map<string, CounterEntry>();

// ── Generic counter helpers ─────────────────────────────────────────────────

function getCount(map: Map<string, CounterEntry>, threadId: string, catId: string, now: number): number {
  const key = `${threadId}:${catId}`;
  const entry = map.get(key);
  if (!entry) return 0;
  if (now - entry.lastAt > HOLD_WINDOW_MS) {
    map.delete(key);
    return 0;
  }
  return entry.count;
}

function incrementCount(map: Map<string, CounterEntry>, threadId: string, catId: string, now: number): number {
  const key = `${threadId}:${catId}`;
  const entry = map.get(key);
  if (!entry || now - entry.lastAt > HOLD_WINDOW_MS) {
    map.set(key, { count: 1, lastAt: now });
    return 1;
  }
  entry.count++;
  entry.lastAt = now;
  return entry.count;
}

// ── Timer counter (wakeAfterMs mode) ────────────────────────────────────────

export function getTimerHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  return getCount(timerHoldCounts, threadId, catId, now);
}

export function incrementTimerHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  return incrementCount(timerHoldCounts, threadId, catId, now);
}

// ── Command counter (wakeWhen mode) ─────────────────────────────────────────

export function getCommandHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  return getCount(commandHoldCounts, threadId, catId, now);
}

export function incrementCommandHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  return incrementCount(commandHoldCounts, threadId, catId, now);
}

// ── Atomic reservation (sol review P1: check-then-act race fix) ─────────────
//
// In Node.js, synchronous code within a single event-loop tick is atomic.
// The old pattern had CHECK (sync) → AWAIT (yields) → INCREMENT (sync),
// allowing concurrent requests to interleave between CHECK and INCREMENT.
// tryReserveHold atomically CHECKs + INCREMENTs in one synchronous call.
// releaseHoldReservation rolls back if later async operations fail.

export interface ReservationResult {
  admitted: boolean;
  count: number;
  max: number;
  /** @internal Prior counter state for exact rollback (present only when admitted). */
  _prior?: { count: number; lastAt: number } | null;
}

/**
 * Atomically check + increment. If the counter is at or above the limit,
 * returns admitted=false with the current count (no increment).
 * If below, increments and returns the new count.
 * Must be called synchronously (no awaits before this in the handler).
 */
export function tryReserveHold(
  mode: HoldMode,
  threadId: string,
  catId: string,
  now: number = Date.now(),
): ReservationResult {
  const map = mode === HOLD_MODE_TIMER ? timerHoldCounts : commandHoldCounts;
  const max = mode === HOLD_MODE_TIMER ? MAX_TIMER_HOLDS_PER_WINDOW : MAX_COMMAND_HOLDS_PER_WINDOW;
  const current = getCount(map, threadId, catId, now);
  if (current >= max) {
    return { admitted: false, count: current, max };
  }
  // Snapshot BEFORE increment for exact rollback (sol R2 P2: without this,
  // a failed request's timestamp extends the window for legitimate holds).
  const key = `${threadId}:${catId}`;
  const entry = map.get(key);
  const prior = entry ? { count: entry.count, lastAt: entry.lastAt } : null;
  const newCount = incrementCount(map, threadId, catId, now);
  return { admitted: true, count: newCount, max, _prior: prior };
}

/**
 * Roll back a reservation (decrement). Called when async operations
 * after reservation fail (e.g. scheduler registration error).
 * No-op if counter is already 0 or entry doesn't exist.
 */
export function releaseHoldReservation(
  mode: HoldMode,
  threadId: string,
  catId: string,
  prior?: { count: number; lastAt: number } | null,
): void {
  const map = mode === HOLD_MODE_TIMER ? timerHoldCounts : commandHoldCounts;
  const key = `${threadId}:${catId}`;
  const entry = map.get(key);
  if (!entry || entry.count <= 0) return;

  entry.count--;

  if (entry.count === 0) {
    map.delete(key);
    return;
  }

  // Restore lastAt if we have a prior snapshot AND the current count
  // matches the prior count (no concurrent modifications interleaved).
  // sol R2 P2: without this, a failed request's timestamp extends the
  // window for legitimate holds.
  if (prior !== undefined && prior !== null && entry.count === prior.count) {
    entry.lastAt = prior.lastAt;
  }
}

// ── Deprecated aliases (timer counter — backward compat) ────────────────────

/** @deprecated Use getTimerHoldCount */
export const getHoldCount = getTimerHoldCount;

/** @deprecated Use incrementTimerHoldCount */
export const incrementHoldCount = incrementTimerHoldCount;
