'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { API_URL } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';

const CHANGE_EVENT = 'clowder:thread-delete-confirm:changed';

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

/** The current client's choice, partitioned by the authenticated API owner. */
export function useThreadDeletePreference() {
  const owner = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    () => apiSessionIdentity.getSnapshot().ownerUserId,
    () => null,
  );
  const key = owner
    ? `clowder:thread-delete-confirm:v1:${encodeURIComponent(API_URL)}:${encodeURIComponent(owner)}`
    : null;
  const read = useCallback(() => {
    if (!key) return true;
    try {
      return window.localStorage.getItem(key) !== 'off';
    } catch {
      return true;
    }
  }, [key]);
  const confirmBeforeDelete = useSyncExternalStore(subscribe, read, () => true);
  const setConfirmBeforeDelete = useCallback(
    (confirm: boolean) => {
      if (!key) return false;
      try {
        window.localStorage.setItem(key, confirm ? 'on' : 'off');
      } catch {
        return false;
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
      return true;
    },
    [key],
  );
  return { confirmBeforeDelete, setConfirmBeforeDelete, ready: owner !== null };
}
