'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface MemoryRead<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/** Independent read states: a failed maintenance read never becomes a zero count. */
export function useMemoryRead<T>(path: string, validate?: (value: unknown) => value is T): MemoryRead<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ data: null as T | null, loading: true, error: false });
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry generation
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: false });
    apiFetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error('Read unavailable');
        const raw: unknown = await response.json();
        if (validate && !validate(raw)) throw new Error('Invalid read response');
        const data = raw as T;
        if (!cancelled) setState({ data, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [path, attempt, validate]);
  return { ...state, retry };
}

export function formatMemoryDate(value: number | string | null): string {
  if (value === null || value === '') return '时间没有记录下来';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '时间没有记录下来';
  const today = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  const prefix =
    day === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
      ? ''
      : day === yesterday
        ? '昨天 '
        : `${d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 `;
  return `${prefix}${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
