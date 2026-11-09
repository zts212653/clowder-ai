'use client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** A continuation belongs to the exact first-page read, including a same-path refresh. */
export function useMemoryPageTail<T extends { nextCursor?: string }>(
  path: string,
  base: T | null,
  merge: (previous: T | null, next: T) => T,
) {
  const generation = useMemo(() => ({ path, base }), [path, base]);
  const active = useRef<typeof generation | null>(null);
  const inFlight = useRef<typeof generation | null>(null);
  const [state, setState] = useState({ generation, data: null as T | null, loading: false, error: false });
  const visible = state.generation === generation ? state : { data: null, loading: false, error: false };
  useLayoutEffect(() => {
    active.current = generation;
    return () => {
      active.current = null;
    };
  }, [generation]);
  const cursor = visible.data ? visible.data.nextCursor : base?.nextCursor;
  const loadMore = async () => {
    if (!base || !cursor || inFlight.current === generation || active.current !== generation) return;
    inFlight.current = generation;
    setState({ generation, data: visible.data, loading: true, error: false });
    try {
      // The same cursor can survive a refresh; do not join its pre-refresh GET.
      const response = await apiFetch(`${path}&cursor=${encodeURIComponent(cursor)}`, undefined, {
        afterCurrentGet: true,
      });
      if (!response.ok) throw new Error('Page unavailable');
      const page = (await response.json()) as T;
      if (active.current !== generation) return;
      setState((previous) => ({
        generation,
        data: merge(previous.generation === generation ? previous.data : null, page),
        loading: false,
        error: false,
      }));
    } catch {
      if (active.current === generation) setState((previous) => ({ ...previous, loading: false, error: true }));
    } finally {
      if (inFlight.current === generation) inFlight.current = null;
    }
  };
  return { ...visible, cursor, loadMore };
}
