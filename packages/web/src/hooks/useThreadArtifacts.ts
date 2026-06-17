/**
 * F232: Fetch the aggregated artifacts of a thread (images / files / code·PR / audio).
 * Backs the ArtifactsPanel right-drawer. Mirrors useGovernanceStatus's
 * AbortController + apiFetch + refetch shape.
 */

import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';

async function fetchArtifacts(tid: string, signal: AbortSignal): Promise<ThreadArtifactDTO[]> {
  const res = await apiFetch(`/api/threads/${encodeURIComponent(tid)}/artifacts`, { signal });
  if (!res.ok) throw new Error(`artifacts fetch failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.artifacts) ? body.artifacts : [];
}

interface UseThreadArtifactsResult {
  artifacts: ThreadArtifactDTO[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export function useThreadArtifacts(threadId: string | undefined): UseThreadArtifactsResult {
  const [artifacts, setArtifacts] = useState<ThreadArtifactDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const tid = threadIdRef.current;
    if (!tid) {
      setArtifacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const result = await fetchArtifacts(tid, ac.signal);
      if (!ac.signal.aborted) setArtifacts(result);
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setArtifacts([]);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []); // stable — reads threadId from ref

  // biome-ignore lint/correctness/useExhaustiveDependencies: threadId triggers refetch
  useEffect(() => {
    refetch();
    return () => abortRef.current?.abort();
  }, [threadId, refetch]);

  return { artifacts, loading, error, refetch };
}
