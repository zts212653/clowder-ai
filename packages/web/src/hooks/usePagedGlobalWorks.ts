import { type GlobalArtifactsResponse, type GlobalWorksPageResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeArtifactPages } from '@/lib/merge-artifact-pages';
import { apiFetch } from '@/utils/api-client';

type Lineage = GlobalArtifactsResponse['workLineage'];
type Snapshot = {
  artifacts: import('@cat-cafe/shared').GlobalArtifactDTO[];
  workLineage: Lineage;
  complete: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
};
const empty = (): Snapshot => ({
  artifacts: [],
  workLineage: 'resolved',
  complete: false,
  loading: true,
  loadingMore: false,
  error: false,
});

class WorksCursorExpired extends Error {}

async function fetchPage(token: string | undefined, signal: AbortSignal): Promise<GlobalWorksPageResponse> {
  const response = await apiFetch(
    `/api/artifacts?view=works&read=pages${token ? `&cursor=${encodeURIComponent(token)}` : ''}`,
    { signal },
  );
  if (response.status === 400 || response.status === 409) throw new WorksCursorExpired();
  if (!response.ok) throw new Error(`Works page failed: ${response.status}`);
  const body: GlobalWorksPageResponse = await response.json();
  if (body.view !== 'works' || !Array.isArray(body.artifacts) || typeof body.complete !== 'boolean')
    throw new Error('Invalid Works page');
  if (body.nextCursor !== undefined && (typeof body.nextCursor !== 'string' || !body.nextCursor))
    throw new Error('Invalid Works cursor');
  if (body.complete ? !!body.nextCursor : !body.nextCursor) throw new Error('Invalid Works continuation');
  return body;
}

/** Drain bounded requests serially, publishing useful batches while the original catalogue is still being read. */
export function usePagedGlobalWorks(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const current = useRef<Snapshot>(empty());
  const confirmed = useRef<Snapshot | null>(null);
  const cursor = useRef<string | undefined>();
  const request = useRef<AbortController | null>(null);
  const cursorExpired = useRef(false);
  const read = useCallback(async (restart: boolean) => {
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    const retained = restart ? confirmed.current : null;
    if (restart) {
      current.current = empty();
      cursor.current = undefined;
      cursorExpired.current = false;
    }
    const publish = (patch: Partial<Snapshot>) => {
      current.current = { ...current.current, ...patch };
      if (current.current.error) confirmed.current = null;
      else if (current.current.complete) confirmed.current = current.current;
      // Rebuild independently; a partial replacement is not a new exact total.
      setSnapshot(
        retained && current.current.loadingMore && !current.current.error
          ? { ...retained, loadingMore: true }
          : current.current,
      );
    };
    publish({ loading: current.current.artifacts.length === 0, loadingMore: true, error: false });
    const visited = new Set<string>();
    try {
      for (;;) {
        const token = cursor.current;
        const body = await fetchPage(token, ac.signal);
        if (ac.signal.aborted) return;
        if (body.nextCursor && (body.nextCursor === token || visited.has(body.nextCursor)))
          throw new Error('Works cursor did not advance');
        if (body.nextCursor) visited.add(body.nextCursor);
        const workLineage =
          current.current.workLineage === 'resolved' && body.workLineage === 'resolved' ? 'resolved' : 'unavailable';
        const artifacts = mergeArtifactPages(current.current.artifacts, body.artifacts, workLineage);
        cursor.current = body.nextCursor;
        publish({
          artifacts,
          workLineage,
          complete: body.complete,
          loading: artifacts.length === 0 && !body.complete,
          loadingMore: !body.complete,
        });
        if (body.complete) break;
      }
    } catch (error) {
      if (!ac.signal.aborted) {
        cursorExpired.current = error instanceof WorksCursorExpired;
        publish({ error: true, complete: false, loading: false, loadingMore: false });
      }
    }
  }, []);
  const restart = useCallback(() => {
    void read(true);
  }, [read]);
  const refetch = useCallback(() => {
    void read(!current.current.error || cursorExpired.current);
  }, [read]);
  useEffect(() => {
    if (enabled) restart();
    else {
      current.current = empty();
      confirmed.current = null;
      cursor.current = undefined;
      setSnapshot(current.current);
    }
    return () => request.current?.abort();
  }, [enabled, restart]);
  return { ...snapshot, loading: enabled && snapshot.loading, refetch, restart };
}
