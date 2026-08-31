'use client';

import type { ThreadBriefV1, ThreadProgressReceiptV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export const THREAD_BRIEF_INVALIDATED_EVENT = 'catcafe:thread-brief-invalidated';
const BRIEF_REFRESH_MS = 4_000;

export interface UseThreadBriefResult {
  readonly brief: ThreadBriefV1 | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly refetch: () => void;
}

export function useThreadBrief(threadId: string): UseThreadBriefResult {
  const [brief, setBrief] = useState<ThreadBriefV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const hasBriefRef = useRef(false);

  const refetch = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!hasBriefRef.current) setLoading(true);
    void apiFetch(`/api/threads/${encodeURIComponent(threadId)}/brief`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Brief fetch failed (${response.status})`);
        const body = await response.json();
        if (!isThreadBrief(body)) throw new Error('Brief response contract mismatch');
        const next = body;
        if (!controller.signal.aborted) {
          setBrief(next);
          hasBriefRef.current = true;
          setError(false);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [threadId]);

  useEffect(() => {
    hasBriefRef.current = false;
    setBrief(null);
    setLoading(true);
    refetch();
    const interval = window.setInterval(refetch, BRIEF_REFRESH_MS);
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) refetch();
    };
    window.addEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    return () => {
      abortRef.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    };
  }, [refetch, threadId]);

  return { brief, loading, error, refetch };
}

export interface ThreadProgressPage {
  readonly items: readonly ThreadProgressReceiptV1[];
  readonly nextCursor: string | null;
}

export async function fetchThreadProgressPage(
  threadId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ThreadProgressPage> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/progress?${query}`, { signal });
  if (!response.ok) throw new Error(`Progress fetch failed (${response.status})`);
  const body = (await response.json()) as Partial<ThreadProgressPage>;
  if (!Array.isArray(body.items) || !(typeof body.nextCursor === 'string' || body.nextCursor === null)) {
    throw new Error('Progress response contract mismatch');
  }
  return { items: body.items as ThreadProgressReceiptV1[], nextCursor: body.nextCursor };
}

function isThreadBrief(value: unknown): value is ThreadBriefV1 {
  if (!value || typeof value !== 'object') return false;
  const brief = value as Partial<ThreadBriefV1>;
  return (
    brief.v === 1 &&
    typeof brief.thread?.id === 'string' &&
    typeof brief.presentationState === 'string' &&
    Array.isArray(brief.currentExecutions) &&
    Array.isArray(brief.attention) &&
    Array.isArray(brief.waits) &&
    Array.isArray(brief.recentProgress)
  );
}
