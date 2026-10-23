/**
 * F232 Phase B: Fetch the globally aggregated artifacts across all user threads.
 * Backs ArtifactsPanel in "全局" scope mode. Mirrors useThreadArtifacts' shape
 * (AbortController + apiFetch + refetch) for drop-in scope switching.
 */

import type { GlobalArtifactDTO, GlobalArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '../utils/api-client';
import { usePagedGlobalWorks } from './usePagedGlobalWorks';
import { useWorksSourceRefresh } from './useThreadArtifacts';

type WorkLineage = GlobalArtifactsResponse['workLineage'];

class GlobalArtifactsReadError extends Error {
  constructor(readonly status: number) {
    super(`global artifacts fetch failed: ${status}`);
  }
}

interface GlobalArtifactsPayload {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
}

function parseGlobalArtifactsResponse(body: unknown, requireComplete: boolean): GlobalArtifactsPayload {
  if (body === null || typeof body !== 'object') {
    return { artifacts: [], workLineage: 'unavailable', complete: false };
  }
  const record = body as Record<string, unknown>;
  return {
    artifacts: Array.isArray(record.artifacts) ? (record.artifacts as GlobalArtifactDTO[]) : [],
    workLineage: record.workLineage === 'resolved' ? 'resolved' : 'unavailable',
    complete: typeof record.complete === 'boolean' ? record.complete : !requireComplete,
  };
}

async function fetchGlobalArtifacts(
  path: string,
  signal: AbortSignal,
  requireComplete: boolean,
  worksView: boolean,
): Promise<GlobalArtifactsPayload> {
  const res = await apiFetch(path, { signal }, { afterCurrentGet: requireComplete });
  if (!res.ok) throw new GlobalArtifactsReadError(res.status);
  const body = await res.json();
  if (worksView && (body === null || typeof body !== 'object' || body.view !== 'works'))
    throw new Error('Works view unavailable');
  return parseGlobalArtifactsResponse(body, requireComplete);
}

interface UseGlobalArtifactsResult {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
  loading: boolean;
  error: boolean;
  loadingMore?: boolean;
  refetch: () => void;
}

export type GlobalArtifactsQuery = { view: 'recent-works'; limit: number } | { view: 'works' };

export function useGlobalArtifacts(
  enabled: boolean,
  query?: GlobalArtifactsQuery,
  ownerKey?: string | null,
): UseGlobalArtifactsResult {
  const worksView = query?.view === 'works';
  const paged = usePagedGlobalWorks(enabled && worksView, ownerKey);
  const [resolvedScope, setResolvedScope] = useState<string | null>(null);
  const resolvedScopeRef = useRef<string | null>(null);
  const [artifacts, setArtifacts] = useState<GlobalArtifactDTO[]>([]);
  const [workLineage, setWorkLineage] = useState<WorkLineage>('unavailable');
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  const hostThreadId = useChatStore((state) => state.currentThreadId);

  const requireComplete = query !== undefined;
  const requestPath = query
    ? `/api/artifacts?view=${encodeURIComponent(query.view)}${'limit' in query ? `&limit=${encodeURIComponent(String(query.limit))}` : ''}`
    : '/api/artifacts';
  const scope = JSON.stringify([requestPath, ownerKey]);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(false);
    setWorkLineage('unavailable');
    try {
      const result = await fetchGlobalArtifacts(requestPath, ac.signal, requireComplete, worksView);
      if (!ac.signal.aborted) {
        setArtifacts(result.artifacts);
        setWorkLineage(result.workLineage);
        setComplete(result.complete);
        setResolvedScope(scope);
        resolvedScopeRef.current = scope;
      }
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      if (
        resolvedScopeRef.current !== scope ||
        (err instanceof GlobalArtifactsReadError && (err.status === 401 || err.status === 403))
      ) {
        setArtifacts([]);
        setResolvedScope(null);
        resolvedScopeRef.current = null;
      }
      setWorkLineage('unavailable');
      setComplete(false);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [requestPath, requireComplete, worksView, scope]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled && !worksView) {
      refetch();
    } else {
      setArtifacts([]);
      setWorkLineage('unavailable');
      setComplete(true);
      setLoading(false);
      setError(false);
    }
    return () => abortRef.current?.abort();
  }, [enabled, refetch, worksView]);

  useWorksSourceRefresh(hostThreadId, enabled && query !== undefined, worksView ? paged.restart : refetch);

  return worksView
    ? paged
    : {
        artifacts: enabled && resolvedScope === scope ? artifacts : [],
        workLineage: resolvedScope === scope ? workLineage : 'unavailable',
        complete: resolvedScope === scope && complete,
        loading: enabled && (loading || !enabledRef.current),
        error,
        refetch,
      };
}
