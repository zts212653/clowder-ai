import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export type ActionRecoveryLane = 'return' | 'dispatch' | 'task';
export const ACTION_RECOVERY_LANES: readonly ActionRecoveryLane[] = ['return', 'dispatch', 'task'];
export interface ActionRecoveryFact {
  readonly v: 1;
  readonly generation: number;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly disposition?: 'parked' | 'interrupted' | 'needs_attention';
  readonly reasonCode?: string;
  readonly claim?: { readonly token: string; readonly expiresAt: number };
}
export interface ActionRecoverySnapshot {
  readonly lease: ActionSuccessorLease;
  readonly revision: number;
  readonly fact: ActionRecoveryFact;
  readonly needsRepair?: boolean;
}
export interface ActionRecoveryPort {
  read(leaseId: string, lane: ActionRecoveryLane): Promise<ActionRecoverySnapshot | null>;
  update(
    snapshot: ActionRecoverySnapshot,
    lane: ActionRecoveryLane,
    fact: ActionRecoveryFact,
    fenceBusiness?: boolean,
    expectedClaim?: string,
  ): Promise<boolean>;
}
export type ActionRecoveryOutcome =
  | { kind: 'waiting' }
  | { kind: 'settled' }
  | { kind: 'stale' }
  | { kind: 'retryable_error'; reason: string }
  | { kind: 'permanent_error'; reason: string };

export function initialActionRecovery(generation: number): ActionRecoveryFact {
  return { v: 1, generation, attempts: 0, nextAttemptAt: 0 };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
/** Corrupt metadata is a disposition, never a fresh retry budget. */
export function validActionRecovery(value: unknown, generation: number): value is ActionRecoveryFact {
  if (!object(value) || value.v !== 1 || value.generation !== generation || !natural(value.attempts)) return false;
  if (value.nextAttemptAt !== null && !natural(value.nextAttemptAt)) return false;
  if (
    value.disposition !== undefined &&
    !['parked', 'interrupted', 'needs_attention'].includes(String(value.disposition))
  )
    return false;
  if (value.reasonCode !== undefined && typeof value.reasonCode !== 'string') return false;
  if (
    value.claim !== undefined &&
    (!object(value.claim) || typeof value.claim.token !== 'string' || !natural(value.claim.expiresAt))
  )
    return false;
  return true;
}
export function planActionRecovery(
  current: ActionRecoveryFact,
  outcome: ActionRecoveryOutcome,
  now: number,
): ActionRecoveryFact {
  const {
    claim: _claim,
    notification: _legacyNotification,
    ...fact
  } = current as ActionRecoveryFact & {
    notification?: unknown;
  };
  if (outcome.kind === 'stale') return { ...fact, nextAttemptAt: now + 30_000 };
  if (outcome.kind === 'settled') return { ...fact, nextAttemptAt: null };
  if (outcome.kind === 'waiting') return { ...fact, nextAttemptAt: now + 30_000 };
  const attempts = fact.attempts + (outcome.kind === 'retryable_error' ? 1 : 0);
  if (outcome.kind === 'permanent_error' || attempts >= 5)
    return {
      ...fact,
      attempts,
      disposition: outcome.kind === 'permanent_error' ? 'needs_attention' : 'parked',
      reasonCode: outcome.reason,
      nextAttemptAt: null,
    };
  return { ...fact, attempts, nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** attempts) };
}
