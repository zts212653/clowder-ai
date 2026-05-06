'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'clowder-pinned-sections';
const SYNC_EVENT = 'clowder-pinned-sync';
const MAX_PINS = 8;

function read(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeAndBroadcast(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

export function usePinnedSections() {
  const [pinned, setPinned] = useState<readonly string[]>([]);

  useEffect(() => {
    setPinned(read());
    const refresh = () => setPinned(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SYNC_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SYNC_EVENT, refresh);
    };
  }, []);

  const pin = useCallback((id: string) => {
    setPinned((prev) => {
      if (prev.includes(id) || prev.length >= MAX_PINS) return prev;
      const next = [...prev, id];
      writeAndBroadcast(next as string[]);
      return next;
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = prev.filter((x) => x !== id);
      writeAndBroadcast(next as string[]);
      return next;
    });
  }, []);

  const isPinned = useCallback((id: string) => pinned.includes(id), [pinned]);

  return { pinned, pin, unpin, isPinned } as const;
}
