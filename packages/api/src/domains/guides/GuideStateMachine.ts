/**
 * B-1: Pure Guide State Machine — forward-only DAG.
 *
 * No I/O, no side effects. Validates transitions and produces
 * next-state objects. All persistence and socket emission lives
 * in GuideLifecycleService.
 */

import type { GuideStateV1, GuideStatus } from '../cats/services/stores/ports/ThreadStore.js';

const VALID_TRANSITIONS: Record<GuideStatus, readonly GuideStatus[]> = {
  offered: ['awaiting_choice', 'active', 'cancelled'],
  awaiting_choice: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isValidTransition(from: GuideStatus, to: GuideStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: GuideStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function validTransitionsFrom(status: GuideStatus): readonly GuideStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/** Create fresh offered state. */
export function createOfferedState(params: { guideId: string; userId: string; offeredBy?: string }): GuideStateV1 {
  return {
    v: 1,
    guideId: params.guideId,
    status: 'offered',
    userId: params.userId,
    offeredAt: Date.now(),
    offeredBy: params.offeredBy,
  };
}

/** Transition to active (from offered or awaiting_choice). */
export function transitionToActive(existing: GuideStateV1): GuideStateV1 {
  return { ...existing, status: 'active', startedAt: Date.now() };
}

/** Transition to awaiting_choice (from offered). */
export function transitionToAwaitingChoice(existing: GuideStateV1): GuideStateV1 {
  return { ...existing, status: 'awaiting_choice' };
}

/** Transition to cancelled. */
export function transitionToCancelled(existing: GuideStateV1): GuideStateV1 {
  return { ...existing, status: 'cancelled', completedAt: Date.now() };
}

/** Transition to completed. */
export function transitionToCompleted(existing: GuideStateV1): GuideStateV1 {
  return { ...existing, status: 'completed', completedAt: Date.now() };
}

/** Apply an arbitrary valid transition with optional currentStep update. */
export function applyTransition(existing: GuideStateV1, to: GuideStatus, currentStep?: number): GuideStateV1 {
  return {
    ...existing,
    status: to,
    ...(to === 'completed' || to === 'cancelled' ? { completedAt: Date.now() } : {}),
    ...(to === 'active' ? { startedAt: Date.now() } : {}),
    ...(currentStep !== undefined ? { currentStep } : {}),
  };
}
