import { useSyncExternalStore } from 'react';

const DESKTOP_QUERY = '(min-width: 768px)';

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
}

const getServerSnapshot = () => false;

export function useIsDesktop(): boolean {
  // Match SSR while hydrating; a client-only mount must see the actual viewport immediately.
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
