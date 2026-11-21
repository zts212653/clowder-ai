import { type GlobalArtifactsResponse, type GlobalWorksPageResponse, projectThreadWorks } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeArtifactPages } from '@/lib/merge-artifact-pages';
import { apiFetch } from '@/utils/api-client';

type Snapshot = {
  artifacts: GlobalWorksPageResponse['artifacts'];
  workLineage: GlobalArtifactsResponse['workLineage'];
  complete: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  stale: boolean;
};
const empty = (): Snapshot => ({
  artifacts: [],
  workLineage: 'resolved',
  complete: false,
  loading: true,
  loadingMore: false,
  error: false,
  hasMore: false,
  stale: false,
});
const EMPTY_SNAPSHOT = empty();
class WorksSnapshotInvalid extends Error {}

async function fetchPage(token: string | undefined, signal: AbortSignal): Promise<GlobalWorksPageResponse> {
  const response = await apiFetch(
    `/api/artifacts?view=works&read=pages${token ? `&cursor=${encodeURIComponent(token)}` : ''}`,
    { signal },
  );
  if ([400, 409, 401, 403].includes(response.status)) throw new WorksSnapshotInvalid();
  if (!response.ok) throw new Error(`Works page failed: ${response.status}`);
  const body: GlobalWorksPageResponse = await response.json();
  if (body.view !== 'works' || !Array.isArray(body.artifacts) || typeof body.complete !== 'boolean')
    throw new Error('Invalid Works page');
  if (body.nextCursor !== undefined && (typeof body.nextCursor !== 'string' || !body.nextCursor))
    throw new Error('Invalid Works cursor');
  if (body.complete ? !!body.nextCursor : !body.nextCursor) throw new Error('Invalid Works continuation');
  return body;
}

/** One initial page; only an explicit continuation admits another bounded, serial batch. */
export function usePagedGlobalWorks(enabled: boolean | number, ownerKey?: string | null, paused = false) {
  const active = Boolean(enabled) && !paused;
  const [snapshot, setSnapshot] = useState(empty);
  const current = useRef(snapshot);
  const cursor = useRef<string>();
  const request = useRef<AbortController | null>(null);
  const refreshing = useRef(false);
  const failedRefresh = useRef(false);
  const owner = useRef(ownerKey);
  const admitted = useRef(false);
  const initialized = useRef(false);
  const changes = useRef(0);
  const invalidate = useCallback(() => {
    request.current?.abort();
    request.current = null;
    cursor.current = undefined;
    initialized.current = true;
    failedRefresh.current = false;
    current.current = { ...empty(), loading: false, error: true };
    setSnapshot(current.current);
  }, []);
  const read = useCallback(
    async (restart: boolean) => {
      if (!admitted.current || (request.current && (!restart || refreshing.current))) return;
      if (!restart && !cursor.current) return;
      request.current?.abort();
      const ac = new AbortController();
      request.current = ac;
      refreshing.current = restart;
      const revision = changes.current;
      let next = restart ? empty() : current.current;
      let token = restart ? undefined : cursor.current;
      const before = projectThreadWorks(next.artifacts, next.workLineage === 'resolved').length;
      current.current = { ...current.current, loading: !initialized.current, loadingMore: true, error: false };
      setSnapshot(current.current);
      const visited = new Set<string>();
      try {
        for (let pages = 0; pages < (restart ? 1 : 4); pages += 1) {
          const body = await fetchPage(token, ac.signal);
          if (ac.signal.aborted) return;
          if (body.nextCursor && (body.nextCursor === token || visited.has(body.nextCursor)))
            throw new Error('Works cursor did not advance');
          if (body.nextCursor) visited.add(body.nextCursor);
          const workLineage =
            next.workLineage === 'resolved' && body.workLineage === 'resolved' ? 'resolved' : 'unavailable';
          next = {
            artifacts: mergeArtifactPages(next.artifacts, body.artifacts, workLineage),
            workLineage,
            complete: body.complete,
            hasMore: !!body.nextCursor,
            loading: false,
            loadingMore: true,
            error: false,
            stale: changes.current !== revision,
          };
          // Commit a whole successful page and its matching continuation together, including on refresh.
          cursor.current = token = body.nextCursor;
          initialized.current = true;
          failedRefresh.current = false;
          current.current = next;
          setSnapshot(next);
          if (!token || projectThreadWorks(next.artifacts, workLineage === 'resolved').length - before >= 24) break;
        }
      } catch (error) {
        if (!ac.signal.aborted) {
          if (error instanceof WorksSnapshotInvalid) invalidate();
          else {
            failedRefresh.current = restart;
            initialized.current = true;
            current.current = { ...current.current, loading: false, error: true };
            setSnapshot(current.current);
          }
        }
      } finally {
        if (request.current === ac) {
          request.current = null;
          current.current = { ...current.current, loading: false, loadingMore: false };
          setSnapshot(current.current);
        }
      }
    },
    [invalidate],
  );
  const restart = useCallback(() => {
    void read(true);
  }, [read]);
  const loadMore = useCallback(() => {
    void read(false);
  }, [read]);
  const refetch = useCallback(() => {
    void read(failedRefresh.current || !cursor.current);
  }, [read]);
  const scheduleRefresh = useCallback(() => {
    changes.current += 1;
    current.current = { ...current.current, stale: true };
    setSnapshot(current.current);
  }, []);
  useEffect(() => {
    if (owner.current !== ownerKey || !enabled) {
      owner.current = ownerKey;
      current.current = empty();
      cursor.current = undefined;
      initialized.current = false;
      failedRefresh.current = false;
      setSnapshot(current.current);
    }
    admitted.current = active;
    if (active) {
      if (!initialized.current || typeof enabled === 'number') restart();
      else setSnapshot(current.current);
    }
    return () => {
      admitted.current = false;
      request.current?.abort();
      request.current = null;
      current.current = { ...current.current, loadingMore: false, stale: initialized.current };
    };
  }, [active, enabled, ownerKey, restart]);
  const visible = enabled && owner.current === ownerKey ? snapshot : EMPTY_SNAPSHOT;
  return {
    ...visible,
    loading: active && visible.loading,
    loadingMore: active && visible.loadingMore,
    refetch,
    restart,
    loadMore,
    scheduleRefresh,
    invalidate,
  };
}
