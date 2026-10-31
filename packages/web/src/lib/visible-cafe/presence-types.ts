/**
 * F258 Visible Café — Presence Types
 *
 * CatPresenceSnapshot is the single source of truth for rendering.
 * State machine: unknown → live ↔ stale → unknown
 * Adapter is the ONLY writer (Defense Line 1).
 */

/** Freshness states for cat presence. */
export type PresenceState = 'live' | 'stale' | 'unknown';

/** Posture determines which sprite row to render. */
export type CatPosture = 'idle' | 'sleeping' | 'working' | 'staged_thought';

/** Confidence level for the current observation. */
export type ConfidenceLevel = 'socket' | 'reconciled';

/**
 * Core snapshot — the ONLY data structure render components consume.
 * Adapter writes it; render reads it via pickPosture() pure function.
 */
export interface CatPresenceSnapshot {
  /** Current freshness state. */
  state: PresenceState;

  /** What the cat is doing (only meaningful when state !== 'unknown'). */
  posture: CatPosture;

  /** Whether cat has a staged thought (INV-3: always false until F255). */
  hasStagedThought: boolean;

  /** When this observation was made (monotonic — rejects older values). */
  observedAt: number;

  /** When this observation expires (observedAt + TTL). */
  expiresAt: number;

  /** How we know this (socket event vs reconcile poll). */
  confidence: ConfidenceLevel;

  /** Reference to the source event that produced this state (for provenance). */
  sourceRef: string | null;
}

/** Star window data — one light per active thread. */
export interface StarLight {
  threadId: string;
  brightness: number; // 0..1 — activity intensity
  /** Stable position derived from hash(threadId). */
  x: number;
  y: number;
}

/**
 * Phase B: Thread metadata stored from reconcile polls.
 * Per-thread data for star card rendering.
 */
export interface ThreadMeta {
  threadId: string;
  title: string | null;
  lastActiveAt: number;
  participants: string[];
  /** Thread-level cat binding (F32-b). Takes priority over participants for catId. */
  preferredCats?: string[];
}

/**
 * Phase B: Per-thread cat posture derived from activity recency.
 * U1 red line: each star = one thread = that thread's cat. Never aggregate.
 */
export interface StarCardSnapshot {
  threadId: string;
  title: string | null;
  /** Cat posture derived from thread activity recency. */
  posture: CatPosture;
  /** Freshness state of per-thread observation. */
  state: PresenceState;
  /** Bound cat ID — first participant or 'unknown'. */
  catId: string;
  /** When the thread was last active. */
  lastActiveAt: number;
  /** Provenance reference. */
  sourceRef: string;
}

/** Recency threshold: within this window = "working". */
export const STAR_CARD_WORKING_THRESHOLD_MS = 30_000; // 30s

/** Recency threshold: within this window but older than working = "idle". */
export const STAR_CARD_IDLE_THRESHOLD_MS = 120_000; // 2 minutes

/** Quiet hours config (Phase A: constant, Phase B: read from user config). */
export interface QuietHoursConfig {
  /** Start hour in local time (0-23). Default: 9 (co-creator 09:00 睡觉). */
  startHour: number;
  /** End hour in local time (0-23). Default: 18 (co-creator 18:00 起床). */
  endHour: number;
}

/** Default quiet hours — matches co-creator's sleep schedule (09:00-18:00). */
export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  startHour: 9,
  endHour: 18,
};

/** TTL for presence freshness (milliseconds). */
export const PRESENCE_TTL_MS = 30_000; // 30 seconds

/** Half-TTL threshold for live → stale transition. */
export const PRESENCE_HALF_TTL_MS = PRESENCE_TTL_MS / 2;

/** Max star lights rendered (INV-7: prevent 1246 threads from all lighting up). */
export const MAX_STAR_LIGHTS = 24;

/** Normal animation tick interval (ms). */
export const TICK_INTERVAL_MS = 100;

/** Quiet hours tick interval (INV-5: ≥ 2× normal). */
export const QUIET_TICK_INTERVAL_MS = TICK_INTERVAL_MS * 3; // 300ms — 3× normal

/** Initial snapshot — unknown state, nothing known. */
export function createInitialSnapshot(): CatPresenceSnapshot {
  return {
    state: 'unknown',
    posture: 'sleeping',
    hasStagedThought: false,
    observedAt: 0,
    expiresAt: 0,
    confidence: 'socket',
    sourceRef: null,
  };
}
