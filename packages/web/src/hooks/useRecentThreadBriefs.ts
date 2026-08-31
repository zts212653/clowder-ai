'use client';

import type { ThreadBriefCollectionV1, ThreadBriefV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { THREAD_BRIEF_INVALIDATED_EVENT } from './useThreadBrief';

const REFRESH_MS = 4_000;

export interface RecentThreadBriefsState {
  readonly current: readonly ThreadBriefV1[];
  readonly recent: readonly ThreadBriefV1[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: boolean;
  readonly refetch: () => void;
  readonly loadMore: () => void;
}

export function useRecentThreadBriefs(): RecentThreadBriefsState {
  const [current, setCurrent] = useState<readonly ThreadBriefV1[]>([]);
  const [recent, setRecent] = useState<readonly ThreadBriefV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const request = useCallback(async (cursor?: string) => {
    requestRef.current?.abort();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    requestRef.current = controller;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const body = await fetchRecentCollection(cursor, controller.signal);
      if (requestRef.current !== controller || generationRef.current !== generation) return;
      setCurrent(body.current);
      setRecent((previous) => mergeRecent(cursor ? previous : [], body.recent, body.current));
      setNextCursor(body.nextCursor);
      setError(false);
    } catch (cause: unknown) {
      if (isAbortedRequest(controller, cause)) return;
      if (!cursor) {
        setCurrent([]);
        setRecent([]);
        setNextCursor(null);
      }
      setError(true);
    } finally {
      if (requestRef.current === controller && generationRef.current === generation) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const refetch = useCallback(() => void request(), [request]);
  const loadMore = useCallback(() => {
    if (nextCursor && !loadingMore) void request(nextCursor);
  }, [loadingMore, nextCursor, request]);

  useEffect(() => {
    refetch();
    const interval = window.setInterval(refetch, REFRESH_MS);
    const onInvalidated = () => refetch();
    window.addEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    return () => {
      generationRef.current += 1;
      requestRef.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    };
  }, [refetch]);

  return { current, recent, nextCursor, loading, loadingMore, error, refetch, loadMore };
}

async function fetchRecentCollection(
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<ThreadBriefCollectionV1> {
  const query = new URLSearchParams({ scope: 'recent', limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const response = await apiFetch(`/api/threads/briefs?${query}`, { signal });
  if (!response.ok) throw new Error(`Recent briefs failed (${response.status})`);
  const body = (await response.json()) as unknown;
  if (!isCollection(body)) throw new Error('Recent briefs contract mismatch');
  return body;
}

function isAbortedRequest(controller: AbortController, cause: unknown): boolean {
  return controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
}

function isCollection(value: unknown): value is ThreadBriefCollectionV1 {
  if (!value || typeof value !== 'object') return false;
  const collection = value as Partial<ThreadBriefCollectionV1>;
  return (
    collection.v === 1 &&
    Array.isArray(collection.current) &&
    Array.isArray(collection.recent) &&
    (typeof collection.nextCursor === 'string' || collection.nextCursor === null)
  );
}

function mergeRecent(
  previous: readonly ThreadBriefV1[],
  incoming: readonly ThreadBriefV1[],
  current: readonly ThreadBriefV1[],
): ThreadBriefV1[] {
  const currentIds = new Set(current.map((brief) => brief.thread.id));
  const byThread = new Map<string, ThreadBriefV1>();
  for (const brief of [...previous, ...incoming]) {
    if (!currentIds.has(brief.thread.id)) byThread.set(brief.thread.id, brief);
  }
  return [...byThread.values()];
}
