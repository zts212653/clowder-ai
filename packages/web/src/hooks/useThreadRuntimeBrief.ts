'use client';

import type { ThreadRuntimeBriefV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { THREAD_BRIEF_INVALIDATED_EVENT } from './useThreadBrief';

const REFRESH_MS = 4_000;

export function useThreadRuntimeBrief(threadId: string) {
  const [brief, setBrief] = useState<ThreadRuntimeBriefV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    void fetchRuntimeBrief(threadId, controller.signal)
      .then((next) => {
        if (abortRef.current !== controller) return;
        setBrief(next);
        setError(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setBrief(null);
        setError(true);
      })
      .finally(() => {
        if (abortRef.current === controller) setLoading(false);
      });
  }, [threadId]);

  useEffect(() => {
    refetch();
    const interval = window.setInterval(refetch, REFRESH_MS);
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

async function fetchRuntimeBrief(threadId: string, signal: AbortSignal): Promise<ThreadRuntimeBriefV1> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/runtime-brief`, { signal });
  if (!response.ok) throw new Error(`Runtime brief failed (${response.status})`);
  const body = (await response.json()) as unknown;
  if (!isRuntimeBrief(body)) throw new Error('Runtime brief contract mismatch');
  return body;
}

function isRuntimeBrief(value: unknown): value is ThreadRuntimeBriefV1 {
  if (!value || typeof value !== 'object') return false;
  const brief = value as Partial<ThreadRuntimeBriefV1>;
  return (
    brief.v === 1 &&
    typeof brief.thread?.id === 'string' &&
    Array.isArray(brief.currentExecutions) &&
    Array.isArray(brief.recentSessions) &&
    typeof brief.anchors === 'object'
  );
}
