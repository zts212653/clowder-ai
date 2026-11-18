'use client';

import { type QuotaPinPreference, type QuotaPinPreferencePatch, quotaPinPreferenceSchema } from '@cat-cafe/shared';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface QuotaPinStoreState {
  readonly loaded: boolean;
  readonly saving: boolean;
  readonly pinned: boolean;
  readonly selectedAccountRefs: readonly string[] | null;
  readonly error: boolean;
}

const DEFAULT_PREFERENCE: QuotaPinPreference = {
  pinned: true,
  selectedAccountRefs: null,
};

const INITIAL_STATE: QuotaPinStoreState = {
  loaded: false,
  saving: false,
  pinned: DEFAULT_PREFERENCE.pinned,
  selectedAccountRefs: DEFAULT_PREFERENCE.selectedAccountRefs,
  error: false,
};

let state: QuotaPinStoreState = INITIAL_STATE;
let confirmed: QuotaPinPreference = DEFAULT_PREFERENCE;
let desired: QuotaPinPreference = DEFAULT_PREFERENCE;
let fetchPromise: Promise<void> | null = null;
let drainPromise: Promise<void> | null = null;
let storeGeneration = 0;
let mutationRevision = 0;
let syncedRevision = 0;
let dirtyPinnedRevision = 0;
let confirmedPinnedRevision = 0;
let dirtyRefsRevision = 0;
let confirmedRefsRevision = 0;
let waiters: Array<{ readonly rev: number; readonly resolve: (ok: boolean) => void }> = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function normalizeRefs(refs: readonly string[] | null): string[] | null {
  return refs ? [...new Set(refs)] : null;
}

function parsePreference(raw: unknown): QuotaPinPreference | null {
  if (!raw || typeof raw !== 'object' || !('pinned' in raw)) return null;
  const parsed = quotaPinPreferenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    pinned: parsed.data.pinned,
    selectedAccountRefs: normalizeRefs(parsed.data.selectedAccountRefs),
  };
}

function ensureLoaded() {
  if (state.loaded || fetchPromise || typeof window === 'undefined') return;
  const observedGen = storeGeneration;
  const observedRevision = mutationRevision;
  fetchPromise = apiFetch('/api/config/quota-pin')
    .then(async (res) => {
      if (!res.ok) return null;
      return parsePreference(await res.json().catch(() => null));
    })
    .then((pref) => {
      if (observedGen !== storeGeneration || observedRevision !== mutationRevision) return;
      if (!pref) {
        state = { ...state, loaded: true };
        return;
      }
      confirmed = pref;
      desired = pref;
      const changed =
        pref.pinned !== state.pinned ||
        JSON.stringify(pref.selectedAccountRefs) !== JSON.stringify(state.selectedAccountRefs);
      state = {
        ...state,
        loaded: true,
        pinned: pref.pinned,
        selectedAccountRefs: pref.selectedAccountRefs,
      };
      if (changed) emit();
    })
    .catch(() => {
      if (observedGen !== storeGeneration || observedRevision !== mutationRevision) return;
      state = { ...state, loaded: true };
    })
    .finally(() => {
      if (observedGen === storeGeneration) {
        fetchPromise = null;
      }
    });
}

function buildPendingPayload(): QuotaPinPreferencePatch {
  const payload: QuotaPinPreferencePatch = {};
  if (dirtyPinnedRevision > confirmedPinnedRevision) {
    payload.pinned = desired.pinned;
  }
  if (dirtyRefsRevision > confirmedRefsRevision) {
    payload.selectedAccountRefs = desired.selectedAccountRefs ? [...desired.selectedAccountRefs] : null;
  }
  return payload.pinned === undefined && payload.selectedAccountRefs === undefined
    ? { pinned: desired.pinned }
    : payload;
}

async function sendSaveRequest(
  body: QuotaPinPreferencePatch,
): Promise<{ ok: boolean; saved: QuotaPinPreference | null }> {
  try {
    const response = await apiFetch('/api/config/quota-pin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, saved: null };
    return { ok: true, saved: parsePreference(await response.json().catch(() => null)) };
  } catch {
    return { ok: false, saved: null };
  }
}

function applySaveOutcome(
  targetRevision: number,
  ok: boolean,
  saved: QuotaPinPreference | null,
  snapshotAtSend: QuotaPinPreference,
) {
  syncedRevision = targetRevision;
  if (ok) {
    confirmed = saved ?? snapshotAtSend;
    confirmedPinnedRevision = Math.max(confirmedPinnedRevision, Math.min(dirtyPinnedRevision, targetRevision));
    confirmedRefsRevision = Math.max(confirmedRefsRevision, Math.min(dirtyRefsRevision, targetRevision));
    if (mutationRevision === targetRevision) {
      desired = confirmed;
      state = { ...confirmed, loaded: true, saving: false, error: false };
      emit();
    }
    return;
  }
  if (mutationRevision === targetRevision) {
    desired = confirmed;
    dirtyPinnedRevision = confirmedPinnedRevision;
    dirtyRefsRevision = confirmedRefsRevision;
    state = { ...confirmed, loaded: true, saving: false, error: true };
    emit();
  }
}

function settleWaitersUpTo(targetRevision: number, ok: boolean) {
  const remaining: typeof waiters = [];
  for (const waiter of waiters) {
    if (waiter.rev <= targetRevision) waiter.resolve(ok);
    else remaining.push(waiter);
  }
  waiters = remaining;
}

async function runDrainLoop(gen: number): Promise<void> {
  try {
    while (syncedRevision < mutationRevision && gen === storeGeneration) {
      const targetRevision = mutationRevision;
      const snapshotAtSend: QuotaPinPreference = { ...desired };
      const { ok, saved } = await sendSaveRequest(buildPendingPayload());
      if (gen !== storeGeneration) return;
      applySaveOutcome(targetRevision, ok, saved, snapshotAtSend);
      settleWaitersUpTo(targetRevision, ok);
    }
  } finally {
    if (gen === storeGeneration) {
      drainPromise = null;
    }
  }
}

export function updateQuotaPinPreference(patch: QuotaPinPreferencePatch): Promise<boolean> {
  const rev = ++mutationRevision;
  if (patch.pinned !== undefined) {
    desired = { ...desired, pinned: patch.pinned };
    dirtyPinnedRevision = rev;
  }
  if (patch.selectedAccountRefs !== undefined) {
    desired = { ...desired, selectedAccountRefs: normalizeRefs(patch.selectedAccountRefs) };
    dirtyRefsRevision = rev;
  }
  state = {
    loaded: true,
    saving: true,
    pinned: desired.pinned,
    selectedAccountRefs: desired.selectedAccountRefs,
    error: false,
  };
  emit();

  const result = new Promise<boolean>((resolve) => {
    waiters.push({ rev, resolve });
  });
  if (!drainPromise) {
    drainPromise = runDrainLoop(storeGeneration);
  }
  return result;
}

export function subscribeQuotaPinStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQuotaPinStoreSnapshot(): QuotaPinStoreState {
  return state;
}

export function resetQuotaPinStoreForTests(): void {
  storeGeneration++;
  fetchPromise = null;
  drainPromise = null;
  mutationRevision = 0;
  syncedRevision = 0;
  dirtyPinnedRevision = 0;
  confirmedPinnedRevision = 0;
  dirtyRefsRevision = 0;
  confirmedRefsRevision = 0;
  confirmed = DEFAULT_PREFERENCE;
  desired = DEFAULT_PREFERENCE;
  for (const waiter of waiters) waiter.resolve(false);
  waiters = [];
  state = INITIAL_STATE;
  emit();
}

export function useQuotaPinPreference() {
  const snapshot = useSyncExternalStore(subscribeQuotaPinStore, getQuotaPinStoreSnapshot, getQuotaPinStoreSnapshot);
  useEffect(() => {
    ensureLoaded();
  }, []);
  const update = useCallback((patch: QuotaPinPreferencePatch) => updateQuotaPinPreference(patch), []);
  return { ...snapshot, update };
}
