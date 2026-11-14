import { useSyncExternalStore } from 'react';
import { MEMORY_CHANGED, MEMORY_CHANGED_STORAGE_KEY } from './memory-changed';

const initial = { generation: 0, sourceGeneration: 0 };
let state = initial;
const listeners = new Set<() => void>();
const events = ['focus', MEMORY_CHANGED];
function storageChanged(event: StorageEvent) {
  if (event.key === MEMORY_CHANGED_STORAGE_KEY) refresh();
}
function refresh(event?: Event) {
  state = {
    generation: state.generation + 1,
    sourceGeneration: state.sourceGeneration + (event?.type === 'focus' ? 0 : 1),
  };
  for (const listener of listeners) listener();
}
const retry = () => refresh();
function subscribe(listener: () => void) {
  if (!listeners.size) {
    for (const event of events) window.addEventListener(event, refresh);
    window.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      for (const event of events) window.removeEventListener(event, refresh);
      window.removeEventListener('storage', storageChanged);
    }
  };
}
const snapshot = () => state;
const serverSnapshot = () => initial;

/** Focus revalidates; a known mutation also withdraws the old destinations immediately. */
export function useRecallRefresh() {
  return { ...useSyncExternalStore(subscribe, snapshot, serverSnapshot), retry };
}
