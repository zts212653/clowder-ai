/**
 * F252 Story Player — Core Types
 *
 * ReplayEvent is the normalized event type consumed by the Replay Engine.
 * TranscriptEvents (from events.jsonl / session API) are adapted into
 * ReplayEvents by the adapter before replay.
 */

// ---------------------------------------------------------------------------
// ReplayEvent — the universal replay unit
// ---------------------------------------------------------------------------

export type ReplayEventType =
  | 'message' // text/assistant/user/system → unified message
  | 'tool_call' // tool_use + matched tool_result
  | 'system' // session_init, done, error, etc.
  | 'thinking'; // thinking/reasoning content

export interface ReplayEvent {
  /** Monotonic index within the replay sequence */
  index: number;
  /** Event type after normalization */
  type: ReplayEventType;
  /** Original timestamp (epoch ms) */
  timestamp: number;
  /** Role: assistant / user / system */
  role: string;
  /** Text content */
  content: string;
  /** Invocation grouping */
  invocationId?: string;
  /** Tool name (normalized from toolName/name dual form) */
  toolName?: string;
  /** Tool input/arguments (stringified or structured) */
  toolInput?: string;
  /** Tool result content */
  toolResult?: string;
  /** Whether tool call errored */
  toolIsError?: boolean;
  /** Cat ID (actor) */
  catId?: string;
  /** Original eventNo for seek */
  eventNo: number;
  /** Original idle gap (ms) before this event that was auto-skipped (AC-B1) */
  idleSkipMs?: number;
  /** Whether this is a pass-ball event — @mention / cross_post (AC-B1) */
  isPassBall?: boolean;
  /** Source thread ID — preserved from raw event for multi-thread partitioning (AC-E5) */
  sourceThreadId?: string;
}

// ---------------------------------------------------------------------------
// Bullet Time state (AC-E4)
// ---------------------------------------------------------------------------

/**
 * Tracks active bullet time slowdown at a pass-ball event.
 *
 * INV-1: progressMs >= 0
 * INV-2: triggerIndex references a valid pass-ball event
 * INV-3: speedFactor always in [MIN_SPEED_FACTOR, 1.0] (enforced by easing fn)
 * INV-4: null when adaptivePacing=false
 * INV-5: null when state=idle or state=ended
 */
export interface BulletTimeState {
  /** Index of the pass-ball event that triggered this bullet time */
  triggerIndex: number;
  /** Real-time progress through the bullet time curve (ms) */
  progressMs: number;
}

// ---------------------------------------------------------------------------
// Replay Engine state
// ---------------------------------------------------------------------------

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'ended';

export type SpeedMultiplier = 1 | 10 | 50 | 100 | 'max';

export interface ReplayEngineState {
  /** Current playback state */
  state: PlaybackState;
  /** Speed multiplier */
  speed: SpeedMultiplier;
  /** Index of the current event being displayed */
  currentIndex: number;
  /** Total number of events */
  totalEvents: number;
  /** Elapsed playback time in ms */
  elapsedMs: number;
  /** Total original duration in ms */
  totalDurationMs: number;
  /** Display mode */
  displayMode: 'cinematic' | 'faithful';
  /** Whether adaptive pacing is active (AC-B1) */
  adaptivePacing: boolean;
  /** Active bullet time state, null when not in bullet time (AC-E4) */
  bulletTime: BulletTimeState | null;
}

// ---------------------------------------------------------------------------
// Guest Card state (AC-E6)
// ---------------------------------------------------------------------------

export interface GuestCardState {
  /** Target thread ID (outside current feature) */
  targetThreadId: string;
  /** Truncated content preview */
  contentSnippet: string;
  /** Cat that initiated the cross-feature interaction */
  catId: string | undefined;
  /** Index of the triggering event */
  eventIndex: number;
}

// ---------------------------------------------------------------------------
// Adapter input (matches TranscriptEvent from API)
// ---------------------------------------------------------------------------

export interface RawTranscriptEvent {
  v: number;
  t: number;
  threadId: string;
  catId: string;
  sessionId: string;
  cliSessionId: string;
  invocationId?: string;
  eventNo: number;
  event: Record<string, unknown>;
}
