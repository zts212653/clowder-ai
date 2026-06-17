/**
 * F229 Phase E0: PetSkinContract v0 projection.
 *
 * Pure function — conciergeState → petState. Zero storage, zero sync (KD-18).
 * Full contract: docs/features/F229-petskin-contract.md
 */

import type { ConciergeBallState } from '../types/concierge.js';

/**
 * Codex Pet animation state — v0 four-state subset.
 * Full set (E1+): idle | running-right | running-left | waving | jumping | failed | waiting | running | review
 */
export type CodexPetState = 'idle' | 'running' | 'review' | 'failed';

/** Projection mapping — concierge ball state → codex pet state. */
export interface PetStateProjection {
  readonly version: 1;
  readonly fallback: 'idle';
  readonly map: Readonly<Partial<Record<ConciergeBallState, CodexPetState>>>;
}

/**
 * V0 default projection (aligned with F229-petskin-contract.md).
 *
 * | ConciergeBallState    | CodexPetState | Why                                    |
 * |-----------------------|---------------|----------------------------------------|
 * | idle                  | idle          | Quiet baseline                         |
 * | sleeping              | idle          | Quiet state, no dedicated animation    |
 * | listening             | idle          | Passive input, visually quiet           |
 * | thinking              | running       | Duty cat is working                    |
 * | found                 | review        | Result ready                           |
 * | needs-confirmation    | idle          | v0 defers 'waiting'; status dot enough |
 * | handoff               | running       | Transitioning / relay                  |
 * | error                 | failed        | Blocked or stuck                       |
 */
export const PET_STATE_PROJECTION_V0: PetStateProjection = {
  version: 1,
  fallback: 'idle',
  map: {
    idle: 'idle',
    sleeping: 'idle',
    listening: 'idle',
    thinking: 'running',
    found: 'review',
    'needs-confirmation': 'idle',
    handoff: 'running',
    error: 'failed',
  },
} as const;

/**
 * Pure projection: ConciergeBallState → CodexPetState.
 *
 * - Deterministic, no side effects, no storage.
 * - Unknown/unmapped values fall back to `projection.fallback` ('idle').
 */
export function projectToPetState(ballState: string, projection: PetStateProjection): CodexPetState {
  return projection.map[ballState as ConciergeBallState] ?? projection.fallback;
}
