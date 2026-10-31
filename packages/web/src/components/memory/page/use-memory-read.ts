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
export function useMemoryRead<T>(path: string, validate?: (value: unknown) => value is T): MemoryRead<T> {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ path, attempt, validate }), [path, attempt, validate]);
  const [state, setState] = useState({ request, data: null as T | null, loading: true, error: false });
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState({ request, data: null, loading: true, error: false });
    const read = request.attempt
      ? apiFetch(request.path, undefined, { afterCurrentGet: true })
      : apiFetch(request.path);
    read
      .then(async (response) => {
        if (!response.ok) throw new Error('Read unavailable');
        const raw: unknown = await response.json();
        if (request.validate && !request.validate(raw)) throw new Error('Invalid read response');
        const data = raw as T;
        if (!cancelled) setState({ request, data, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ request, data: null, loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  return state.request === request
    ? { data: state.data, loading: state.loading, error: state.error, retry }
    : { data: null, loading: true, error: false, retry };
}

export function formatMemoryDate(value: number | string | null): string {
  if (value === null || value === '') return '时间没有记录下来';
  if (typeof value === 'string' && /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return memoryDate(value);
  return memoryTime(value);
}
