/**
 * F232: Fetch the aggregated artifacts of a thread (images / files / code·PR / audio).
 * Backs the ArtifactsPanel right-drawer. Mirrors useGovernanceStatus's
 * AbortController + apiFetch + refetch shape.
 */

import { projectThreadWorks, type ThreadArtifactDTO, type ThreadArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';
import { useThreadLiveness, useThreadMessages } from './useThreadScopedSelectors';

const EMPTY_ARTIFACTS: ThreadArtifactDTO[] = [];

async function fetchArtifacts(tid: string, signal: AbortSignal, view?: 'works'): Promise<ThreadArtifactsResponse> {
  const res = await apiFetch(`/api/threads/${encodeURIComponent(tid)}/artifacts${view ? '?view=works' : ''}`, {
    signal,
  });
  if (!res.ok) throw new Error(`artifacts fetch failed: ${res.status}`);
  const body = await res.json();
  if (view && (body.view !== 'works' || !Array.isArray(body.artifacts))) throw new Error('Works view unavailable');
  return { ...body, artifacts: Array.isArray(body.artifacts) ? body.artifacts : [] };
}

interface UseThreadArtifactsResult {
  artifacts: ThreadArtifactDTO[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
  works: ThreadArtifactDTO[];
  total: number | null;
  complete: boolean;
}

function sourceCoverage(result: ThreadArtifactsResponse, view?: 'works') {
  const validTotal = Number.isSafeInteger(result.total) && (result.total ?? -1) >= 0;
  return {
    total: validTotal ? (result.total ?? null) : view ? null : result.artifacts.length,
    complete: view ? result.complete === true && result.workLineage === 'resolved' && validTotal : true,
    lineageResolved: result.workLineage === 'resolved',
  };
}

/** Refresh original source projections on material/completion and owner changes, never streamed text tokens. */
export function useWorksSourceRefresh(threadId: string | undefined, enabled: boolean, refetch: () => void) {
  const messages = useThreadMessages(enabled ? (threadId ?? null) : null);
  const { hasActive } = useThreadLiveness(enabled ? (threadId ?? null) : null);
  const materialKey = useMemo(
    () =>
      JSON.stringify([
        hasActive,
        messages.map((message) => [
          message.id,
          message.timestamp,
          message.isStreaming,
          message.extra?.rich,
          message.contentBlocks?.filter((block) => block.type !== 'text'),
        ]),
      ]),
    [messages, hasActive],
  );
  const previous = useRef({ threadId, materialKey, enabled });
  useEffect(() => {
    const changed =
      previous.current.enabled &&
      previous.current.threadId === threadId &&
      previous.current.materialKey !== materialKey;
    previous.current = { threadId, materialKey, enabled };
    if (enabled && changed) refetch();
  }, [enabled, materialKey, threadId, refetch]);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', refetch);
    return () => window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', refetch);
  }, [enabled, refetch]);
}

export function useThreadArtifacts(threadId: string | undefined, view?: 'works'): UseThreadArtifactsResult {
  const scope = JSON.stringify([threadId, view]);
  const [resolvedScope, setResolvedScope] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ThreadArtifactDTO[]>([]);
  const [loading, setLoading] = useState(Boolean(threadId));
  const [error, setError] = useState(false);
  const [coverage, setCoverage] = useState<{ total: number | null; complete: boolean; lineageResolved: boolean }>({
    total: null,
    complete: false,
    lineageResolved: false,
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const tid = threadIdRef.current;
    if (!tid) {
      setResolvedScope(null);
      setArtifacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    const requestedView = viewRef.current;
    try {
      const result = await fetchArtifacts(tid, ac.signal, requestedView);
      if (!ac.signal.aborted) {
        setArtifacts(result.artifacts);
        setCoverage(sourceCoverage(result, requestedView));
        setResolvedScope(JSON.stringify([tid, requestedView]));
      }
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setResolvedScope(null);
      setArtifacts([]);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []); // stable — reads threadId from ref

  // biome-ignore lint/correctness/useExhaustiveDependencies: threadId triggers refetch
  useEffect(() => {
    refetch();
    return () => abortRef.current?.abort();
  }, [threadId, view, refetch]);

  useWorksSourceRefresh(threadId, view === 'works', refetch);

  const works = useMemo(
    () => projectThreadWorks(artifacts, coverage.lineageResolved),
    [artifacts, coverage.lineageResolved],
  );
  const sameScope = resolvedScope === scope;
  return {
    artifacts: sameScope ? artifacts : EMPTY_ARTIFACTS,
    loading: loading || (Boolean(threadId) && !sameScope && !error),
    error,
    refetch,
    works: sameScope ? works : EMPTY_ARTIFACTS,
    total: sameScope ? coverage.total : null,
    complete: sameScope && coverage.complete,
  };
}
