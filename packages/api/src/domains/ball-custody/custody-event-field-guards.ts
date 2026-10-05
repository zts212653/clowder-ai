import type { BallCustodyEvent, BallEventKind, BallState } from '@cat-cafe/shared';
import {
  A2A_DISPATCH_DISPOSITIONS,
  DISPATCH_TERMINAL_VIAS,
  MANAGED_HOLD_DISPOSITIONS,
  MANAGED_HOLD_RETIRED_REASONS,
} from './ball-custody-events.js';

/**
 * Value guards for the custody event inspector (F167 PR-2, review P1 on #5031).
 *
 * A field NAME on the whitelist says nothing about the VALUE: the ledger payload is `Record<string, unknown>` and
 * Redis returns it through JSON.parse with a type assertion. Everything the inspector reads from the ledger passes
 * through one of these before it can leave: a code only if it is a code its event kind defines, an identifier only
 * if it looks like one, a time only if it is a finite number. A value that fails is withheld by the caller and
 * named, never replaced by a guess.
 *
 * The exhaustive records below are compile-time fences: adding an event kind or a ball state without listing it
 * here is a type error, not a silent "unrecognized".
 */

const EVENT_KINDS = {
  'ball.handed': true,
  'ball.handed_cvo': true,
  'ball.void_pass': true,
  'ball.held': true,
  'ball.hold_expired': true,
  'invocation.started': true,
  'invocation.heartbeat': true,
  'invocation.died': true,
  'task.blocked': true,
  'task.unblocked': true,
  'task.idle_long': true,
  'task.done': true,
  'ball.wake_sent': true,
  'ball.wake_condition_met': true,
  'ball.hold_dispositioned': true,
  'ball.dispatch_dispositioned': true,
  'ball.frozen': true,
  'ball.degraded': true,
  'ball.abandoned': true,
} as const satisfies Record<BallEventKind, true>;

const BALL_STATES = {
  new: true,
  active: true,
  blocked: true,
  parked: true,
  dead: true,
  void: true,
  zombie: true,
  resolved: true,
} as const satisfies Record<BallState, true>;

export type CodeField = 'disposition' | 'retiredReason' | 'via';

/** The codes each event kind defines. A code field under any other kind is not a code. */
const CODE_SETS: Partial<Record<BallEventKind, Partial<Record<CodeField, readonly string[]>>>> = {
  'ball.hold_dispositioned': {
    disposition: MANAGED_HOLD_DISPOSITIONS,
    retiredReason: MANAGED_HOLD_RETIRED_REASONS,
  },
  'ball.dispatch_dispositioned': {
    disposition: A2A_DISPATCH_DISPOSITIONS,
    via: DISPATCH_TERMINAL_VIAS,
  },
};

/** Ids are opaque, so they are only shape-bounded: one token, no whitespace or control characters, 200 at most. */
const IDENTIFIER = /^[^\s\p{Cc}]{1,200}$/u;

export function eventKindOf(value: unknown): BallEventKind | undefined {
  return typeof value === 'string' && Object.hasOwn(EVENT_KINDS, value) ? (value as BallEventKind) : undefined;
}

export function ballStateOf(value: unknown): BallState | undefined {
  return typeof value === 'string' && Object.hasOwn(BALL_STATES, value) ? (value as BallState) : undefined;
}

export function codeOf(kind: BallEventKind | undefined, field: CodeField, value: unknown): string | undefined {
  const allowed = kind ? CODE_SETS[kind]?.[field] : undefined;
  return typeof value === 'string' && allowed?.includes(value) ? value : undefined;
}

export function identifierOf(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

export function timeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The payload as a plain record: a stored event whose payload is missing or not an object reads as empty. */
export function payloadOf(event: BallCustodyEvent): Record<string, unknown> {
  const { payload } = event;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {};
}
