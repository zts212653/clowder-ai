'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useState that persists to localStorage.
 * - SSR-safe: starts with defaultValue, reads localStorage after mount.
 * - Writes synchronously in setter (no effect race with hydration).
 */
export function usePersistedState(
  key: string,
  defaultValue: number,
): [number, (v: number | ((prev: number) => number)) => void, () => void] {
  const [value, setValueRaw] = useState(defaultValue);

  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;

  const keyRef = useRef(key);
  keyRef.current = key;

  // After mount, read persisted value from localStorage.
  // No write effect needed — setValue/reset write synchronously.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) setValueRaw(parsed);
      }
    } catch {
      /* storage unavailable */
    }
  }, [key]);

  // Write synchronously in the setter — no effect race with hydration.
  const setValue = useCallback((v: number | ((prev: number) => number)) => {
    setValueRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try {
        localStorage.setItem(keyRef.current, String(next));
      } catch {
        /* quota error */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const d = defaultRef.current;
    setValueRaw(d);
    try {
      localStorage.setItem(keyRef.current, String(d));
    } catch {
      /* quota error */
    }
  }, []);

  return [value, setValue, reset];
}
