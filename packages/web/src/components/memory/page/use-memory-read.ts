'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { memoryDate, memoryTime } from './memory-time';

export interface MemoryRead<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/** Independent read states: a failed maintenance read never becomes a zero count. */
export function useMemoryRead<T>(
  path: string,
  validate?: (value: unknown) => value is T,
  needed: boolean | number = true,
  interval?: number,
): MemoryRead<T> {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ path, attempt, validate }), [path, attempt, validate]);
  const [state, setState] = useState({ request, data: null as T | null, loading: true, error: false });
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    setState((state) => ({
      request,
      data: state.request.path === request.path ? state.data : null,
      loading: state.data === null || state.request.path !== request.path,
      error: false,
    }));
    const read = () => {
      if (document.hidden) return;
      const pending = request.attempt
        ? apiFetch(request.path, undefined, { afterCurrentGet: true })
        : apiFetch(request.path);
      void pending
        .then(async (response) => {
          if (!response.ok) throw new Error('Read unavailable');
          const raw: unknown = await response.json();
          if (request.validate && !request.validate(raw)) throw new Error('Invalid read response');
          if (!cancelled) setState({ request, data: raw as T, loading: false, error: false });
        })
        .catch(() => {
          if (!cancelled) setState({ request, data: null, loading: false, error: true });
        });
    };
    read();
    const timer = interval ? setInterval(read, interval) : undefined;
    document.addEventListener('visibilitychange', read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [request, needed, interval]);
  if (state.request === request) return { data: state.data, loading: state.loading, error: state.error, retry };
  // A retry of the same path keeps what is shown while it re-reads; a new path starts empty.
  const same = state.request.path === request.path;
  return { data: same ? state.data : null, loading: !same || state.data === null, error: false, retry };
}

export function formatMemoryDate(value: number | string | null): string {
  if (value === null || value === '') return '时间没有记录下来';
  if (typeof value === 'string' && /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return memoryDate(value);
  return memoryTime(value);
}
