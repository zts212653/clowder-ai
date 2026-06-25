/**
 * F244 Phase D — localStorage exposure state management (#997).
 *
 * Tracks which tips have been shown per scope (surface + audience + contexts)
 * so the selector can prioritise unseen tips. State persists across page reloads
 * via localStorage; multi-tab race is intentionally unguarded (spec KD-13: worst
 * case = one extra exposure, not worth a lock or broadcast for D1).
 */

import {
  computeExposureScope,
  computeInventoryFingerprint,
  migrateExposureState,
  type TipExposureState,
} from '@cat-cafe/shared';

const STORAGE_PREFIX = 'cat-cafe:tip-exposure:';

// ── Serialisation ────────────────────────────────────────────────────────────

interface PersistedExposureState {
  exposed: string[];
  firstSeen: Record<string, number>;
  fingerprint: string;
}

function serialise(state: TipExposureState): string {
  const obj: PersistedExposureState = {
    exposed: [...state.exposed],
    firstSeen: Object.fromEntries(state.firstSeen),
    fingerprint: state.fingerprint,
  };
  return JSON.stringify(obj);
}

function deserialise(json: string): TipExposureState | null {
  try {
    const obj = JSON.parse(json) as PersistedExposureState;
    if (!obj || typeof obj.fingerprint !== 'string') return null;
    return {
      exposed: new Set(Array.isArray(obj.exposed) ? obj.exposed : []),
      firstSeen: new Map(Object.entries(obj.firstSeen ?? {})),
      fingerprint: obj.fingerprint,
    };
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load or initialise exposure state for a scope.
 * Handles fingerprint migration automatically when inventory changes.
 */
export function loadExposureState(scope: string, currentTipIds: readonly string[], now: number): TipExposureState {
  const fingerprint = computeInventoryFingerprint(currentTipIds);
  const empty: TipExposureState = { exposed: new Set(), firstSeen: new Map(), fingerprint };

  try {
    if (typeof window === 'undefined' || !window.localStorage) return empty;

    const raw = localStorage.getItem(STORAGE_PREFIX + scope);
    if (!raw) return empty;

    const existing = deserialise(raw);
    if (!existing) return empty;

    // Fingerprint match → state is current
    if (existing.fingerprint === fingerprint) return existing;

    // Fingerprint changed → migrate (add new tips, prune deleted)
    const migrated = migrateExposureState(existing, currentTipIds, now);
    saveExposureState(scope, migrated);
    return migrated;
  } catch {
    // localStorage blocked or sandboxed origin — degrade to empty state
    return empty;
  }
}

/** Persist exposure state for a scope. */
export function saveExposureState(scope: string, state: TipExposureState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(STORAGE_PREFIX + scope, serialise(state));
  } catch {
    // localStorage full or blocked — degrade silently
  }
}

/**
 * Mark a single tip as exposed and persist.
 * Returns the updated state.
 */
export function markTipExposed(scope: string, state: TipExposureState, tipId: string): TipExposureState {
  if (state.exposed.has(tipId)) return state;
  const newExposed = new Set(state.exposed);
  newExposed.add(tipId);
  const updated = { ...state, exposed: newExposed };
  saveExposureState(scope, updated);
  return updated;
}

/**
 * Check whether all eligible tip IDs have been exposed in this scope.
 */
export function isRoundComplete(state: TipExposureState, eligibleTipIds: readonly string[]): boolean {
  return eligibleTipIds.length > 0 && eligibleTipIds.every((id) => state.exposed.has(id));
}

/**
 * Reset the exposure scope (clear exposed set, keep firstSeen + fingerprint).
 * Call when isRoundComplete returns true to start a fresh round.
 */
export function resetExposureScope(scope: string, state: TipExposureState): TipExposureState {
  const reset: TipExposureState = {
    exposed: new Set(),
    firstSeen: state.firstSeen,
    fingerprint: state.fingerprint,
  };
  saveExposureState(scope, reset);
  return reset;
}

export { computeExposureScope, computeInventoryFingerprint };
