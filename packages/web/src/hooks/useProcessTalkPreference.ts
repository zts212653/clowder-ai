'use client';

import { type ProcessTalkMode, type ProcessTalkPreference, processTalkPreferenceSchema } from '@cat-cafe/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';

interface PreferenceState {
  snapshot: ProcessTalkPreference | null;
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error';
  error: 'load' | 'save' | null;
}
const EMPTY: PreferenceState = { snapshot: null, status: 'idle', error: null };
let state = EMPTY;
let generation = 0;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
function publish(next: PreferenceState) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadProcessTalkPreference(): Promise<void> {
  if (loading) return loading;
  const current = ++generation;
  publish({ ...state, status: 'loading', error: null });
  loading = (async () => {
    try {
      const response = await apiFetch('/api/config/process-talk');
      if (!response.ok) throw new Error('Cannot read process-talk preference');
      const snapshot = processTalkPreferenceSchema.parse(await response.json());
      if (current === generation) publish({ snapshot, status: 'ready', error: null });
    } catch {
      if (current === generation) publish({ snapshot: null, status: 'error', error: 'load' });
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

export async function saveProcessTalkPreference(mode: ProcessTalkMode): Promise<boolean> {
  const previous = state.snapshot;
  if (!previous || state.status !== 'ready') return false;
  const current = ++generation;
  publish({ snapshot: previous, status: 'saving', error: null });
  try {
    const response = await apiFetch('/api/config/process-talk', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, expectedOwnerUserId: previous.ownerUserId }),
    });
    if (!response.ok) {
      if ([401, 403, 409].includes(response.status) && current === generation)
        publish({ snapshot: null, status: 'error', error: 'load' });
      throw new Error('Cannot save process-talk preference');
    }
    const snapshot = processTalkPreferenceSchema.parse(await response.json());
    if (snapshot.ownerUserId !== previous.ownerUserId || snapshot.mode !== mode)
      throw new Error('Preference owner changed');
    if (current !== generation) return false;
    publish({ snapshot, status: 'ready', error: null });
    return true;
  } catch {
    if (current === generation && state.snapshot) publish({ snapshot: previous, status: 'ready', error: 'save' });
    return false;
  }
}

/** One server-backed personal snapshot for settings and all replies; never a per-thread preference. */
export function useProcessTalkPreference(enabled = true) {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
  useEffect(() => {
    if (enabled && state.status === 'idle') void loadProcessTalkPreference();
  }, [enabled]);
  return {
    ...snapshot,
    mode: snapshot.snapshot?.mode ?? 'whole',
    load: loadProcessTalkPreference,
    save: saveProcessTalkPreference,
  };
}

export function resetProcessTalkPreferenceForTest(): void {
  ++generation;
  loading = undefined;
  publish(EMPTY);
}
