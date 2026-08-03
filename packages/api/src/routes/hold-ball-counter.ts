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

// ── Deprecated aliases (timer counter — backward compat) ────────────────────

/** @deprecated Use getTimerHoldCount */
export const getHoldCount = getTimerHoldCount;

/** @deprecated Use incrementTimerHoldCount */
export const incrementHoldCount = incrementTimerHoldCount;
