import { useSyncExternalStore } from 'react';
import { MATTER_MEMORY_CHANGED } from './matter-memory-events';

let generation = 0;
const listeners = new Set<() => void>();
const events = ['focus', MATTER_MEMORY_CHANGED];
function refresh() {
  generation++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  if (!listeners.size) for (const event of events) window.addEventListener(event, refresh);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) for (const event of events) window.removeEventListener(event, refresh);
  };
}
const snapshot = () => generation;
const serverSnapshot = () => 0;

/** One browser refresh names the same generation across all mounted consumers. */
export function useRecallRefresh() {
  return { generation: useSyncExternalStore(subscribe, snapshot, serverSnapshot), retry: refresh };
}
