'use client';
import type { StoredEventMemory } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EventPage {
  events: StoredEventMemory[];
  meta: { hasMore: boolean; nextOffset?: number };
}
async function loadBrakePage(offset: number, since: number | null): Promise<EventPage> {
  const params = new URLSearchParams({ trigger: 'human_brake', limit: '50', offset: String(offset) });
  if (since !== null) params.set('since', String(since));
  const response = await apiFetch(`/api/memory/events?${params}`);
  if (!response.ok) throw new Error('Read unavailable');
  const page = (await response.json()) as EventPage;
  if (page.meta.hasMore && (page.meta.nextOffset === undefined || page.meta.nextOffset <= offset))
    throw new Error('Invalid page cursor');
  return page;
}
export function useBrakes(days: number) {
  const [events, setEvents] = useState<StoredEventMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [next, setNext] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const since = useMemo(() => (days ? Date.now() - days * 86_400_000 : null), [days]);
  const request = useCallback(
    async (offset: number, version: number) => {
      setLoading(true);
      setError(false);
      try {
        const page = await loadBrakePage(offset, since);
        if (version !== generation.current) return;
        setEvents((previous) => (offset === 0 ? page.events : [...previous, ...page.events]));
        setNext(page.meta.hasMore ? (page.meta.nextOffset ?? null) : null);
      } catch {
        if (version === generation.current) setError(true);
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [since],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts an initial failed read
  useEffect(() => {
    const version = ++generation.current;
    setEvents([]);
    setNext(null);
    void request(0, version);
    return () => {
      ++generation.current;
    };
  }, [request, attempt]);
  return {
    events,
    loading,
    error,
    hasMore: next !== null,
    retry: () => (next === null ? setAttempt((n) => n + 1) : void request(next, generation.current)),
    loadMore: () => {
      if (!loading && next !== null) void request(next, generation.current);
    },
  };
}
