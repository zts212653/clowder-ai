/**
 * Game Engine Type System (F101)
 *
 * Three-layer architecture:
 * - GameDefinition: rules (pure data, no state)
 * - GameRuntime: state machine + event log (Redis-persisted)
 * - GameView: scoped read-only view (what a player sees)
 */

// === Basic Types ===

/** Seat identifier: P1, P2, ... Pn */
export type SeatId = `P${number}`;

/** Who occupies a seat */
export type ActorType = 'human' | 'cat' | 'system';

/** Event visibility scope */
export type EventScope = 'public' | `seat:${SeatId}` | `faction:${string}` | 'judge' | 'god';

/** A seat in the game */
export interface Seat {
  seatId: SeatId;
  actorType: ActorType;
  actorId: string;
  role: string;
  alive: boolean;
  properties: Record<string, unknown>;
}

// === Game Definition (rules, pure data) ===

export interface GameDefinition {
  gameType: string;
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  roles: RoleDefinition[];
  phases: PhaseDefinition[];
  actions: ActionDefinition[];
  winConditions: WinCondition[];
}

export interface RoleDefinition {
  name: string;
  faction: string;
  nightActionPhase?: string;
  description: string;
}

export interface PhaseDefinition {
  name: string;
  type: 'night_action' | 'day_discuss' | 'day_vote' | 'resolve' | 'announce';
  actingRole?: string;
  timeoutMs: number;
  autoAdvance: boolean;
}

export interface ActionDefinition {
  name: string;
  allowedRole: string;
  allowedPhase: string;
  targetRequired: boolean;
  schema: Record<string, unknown>;
}

export interface WinCondition {
  faction: string;
  description: string;
  check: string; // serialized condition identifier
}

// === Game Runtime (state machine) ===

export interface GameRuntime {
  gameId: string;
  threadId: string;
  gameType: string;
  definition: GameDefinition;
  seats: Seat[];
  currentPhase: string;
  round: number;
  eventLog: GameEvent[];
  pendingActions: Record<string, PendingAction>;
  status: 'lobby' | 'playing' | 'paused' | 'finished';
  winner?: string;
  config: GameConfig;
  phaseStartedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface GameEvent {
  eventId: string;
  round: number;
  phase: string;
  type: string;
  scope: EventScope;
  payload: Record<string, unknown>;
  timestamp: number;
  /** When this event becomes visible: live (immediately), phase_end, game_end */
  revealPolicy?: 'live' | 'phase_end' | 'game_end';
}

export interface GameAction {
  seatId: SeatId;
  actionName: string;
  targetSeat?: SeatId;
  params?: Record<string, unknown>;
  submittedAt: number;
}

// === Phase F: Action Status + Ballot + Resolution ===

export type ActionStatus = 'waiting' | 'acting' | 'acted' | 'timed_out' | 'fallback';

const VALID_ACTION_STATUSES = new Set<string>(['waiting', 'acting', 'acted', 'timed_out', 'fallback']);

export function isValidActionStatus(value: unknown): value is ActionStatus {
  return typeof value === 'string' && VALID_ACTION_STATUSES.has(value);
}

export interface PendingAction extends GameAction {
  status: ActionStatus;
  requestedAt: number;
  fallbackSource?: 'heuristic' | 'random';
}

export interface Ballot {
  voterSeat: string;
  choice: string | null;
  revision: number;
  locked: boolean;
  source: 'player' | 'llm' | 'fallback' | 'random';
  submittedAt: number;
}

export interface Resolution {
  winningChoice: string | null;
  tiePolicy: 'no_kill' | 'random_tied';
  revoteCount: number;
  fallbackApplied: boolean;
}

export interface GameConfig {
  timeoutMs: number;
  voiceMode: boolean;
  humanSeat?: SeatId;
  humanRole: 'player' | 'god-view' | 'detective';
  /** Detective mode: the seat whose perspective the observer inherits */
  detectiveSeatId?: SeatId;
  /** UserId of the human observer (god-view/detective) for state broadcast */
  observerUserId?: string;
}

// === Game View (scoped read-only) ===

export interface GameView {
  gameId: string;
  threadId: string;
  gameType: string;
  status: 'lobby' | 'playing' | 'paused' | 'finished';
  currentPhase: string;
  round: number;
  seats: SeatView[];
  visibleEvents: GameEvent[];
  myActions?: GameAction[];
  winner?: string;
  /** Epoch ms when current phase started (for countdown timer) */
  phaseStartedAt?: number;
  config: Pick<GameConfig, 'timeoutMs' | 'voiceMode' | 'humanRole'> & {
    humanSeat?: SeatId;
    detectiveSeatId?: SeatId;
  };
  /** Aggregate action progress: how many expected actors have submitted */
  submittedCount?: number;
  /** Total expected actors for current phase */
  totalExpected?: number;
  /** Filled when status === 'finished' — per-player stats + MVP */
  gameStats?: GameResultStats;
}

/** Post-game result stats for display in the result screen */
export interface GameResultStats {
  winner: string;
  rounds: number;
  duration: number;
  mvpSeatId: string;
  mvpReason: string;
  players: Array<{
    seatId: string;
    actorId: string;
    role: string;
    faction: string;
    survived: boolean;
    won: boolean;
    killCount: number;
    savedCount: number;
    divineCount: number;
  }>;
}

export interface SeatView {
  seatId: SeatId;
  actorType: ActorType;
  actorId: string;
  displayName: string;
  role?: string;
  faction?: string;
  alive: boolean;
  /** Whether this seat has submitted an action for the current phase */
  hasActed?: boolean;
  /** Action status — only populated in god-view */
  actionStatus?: ActionStatus;
}

// === Type Guards ===

const SEAT_ID_PATTERN = /^P([1-9]\d*)$/;

export function isSeatId(value: unknown): value is SeatId {
  return typeof value === 'string' && SEAT_ID_PATTERN.test(value);
}

export function isValidScope(value: unknown): value is EventScope {
  if (typeof value !== 'string') return false;
  if (value === 'public' || value === 'judge' || value === 'god') return true;
  if (value.startsWith('seat:')) {
    return isSeatId(value.slice(5));
  }
  if (value.startsWith('faction:')) {
    return value.length > 'faction:'.length;
  }
  return false;
}

export function isGameEvent(value: unknown): value is GameEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['eventId'] === 'string' &&
    typeof v['round'] === 'number' &&
    typeof v['phase'] === 'string' &&
    typeof v['type'] === 'string' &&
    isValidScope(v['scope']) &&
    typeof v['payload'] === 'object' &&
    v['payload'] !== null &&
    typeof v['timestamp'] === 'number'
  );
}
