/**
 * F232 Phase B: Fetch the globally aggregated artifacts across all user threads.
 * Backs ArtifactsPanel in "全局" scope mode. Mirrors useThreadArtifacts' shape
 * (AbortController + apiFetch + refetch) for drop-in scope switching.
 */

import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';

async function fetchGlobalArtifacts(signal: AbortSignal): Promise<GlobalArtifactDTO[]> {
  const res = await apiFetch('/api/artifacts', { signal });
  if (!res.ok) throw new Error(`global artifacts fetch failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.artifacts) ? body.artifacts : [];
}

interface UseGlobalArtifactsResult {
  artifacts: GlobalArtifactDTO[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export function useGlobalArtifacts(enabled: boolean): UseGlobalArtifactsResult {
  const [artifacts, setArtifacts] = useState<GlobalArtifactDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(false);
    try {
      const result = await fetchGlobalArtifacts(ac.signal);
      if (!ac.signal.aborted) setArtifacts(result);
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setArtifacts([]);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      refetch();
    } else {
      setArtifacts([]);
      setLoading(false);
      setError(false);
    }
    return () => abortRef.current?.abort();
  }, [enabled, refetch]);

  return { artifacts, loading, error, refetch };
}
