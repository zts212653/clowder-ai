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

/**
 * Quiet time after a global walk settles before a source change may start another one. A walk
 * re-reads the whole owner catalogue (≈120 pages on the 2026-10-24 runtime), so source changes
 * from a busy host thread are coalesced instead of aborting and restarting from page one.
 */
export const GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS = 30_000;

const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Drain bounded requests serially, publishing useful batches while the original catalogue is still being read. */
export function usePagedGlobalWorks(enabled: boolean, ownerKey?: string | null, paused = false) {
  const active = enabled && !paused;
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const current = useRef<Snapshot>(empty());
  const retainedSnapshot = useRef<Snapshot | null>(null);
  const cursor = useRef<string | undefined>();
  const request = useRef<AbortController | null>(null);
  const cursorExpired = useRef(false);
  const owner = useRef(ownerKey);
  const admitted = useRef(false);
  const walking = useRef(false);
  const settledAt = useRef(Number.NEGATIVE_INFINITY);
  const refreshPending = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armRefresh = useRef(() => {});
  const read = useCallback(async (restart: boolean) => {
    if (!admitted.current) return;
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    walking.current = true;
    const retained = restart ? retainedSnapshot.current : null;
    if (restart) {
      current.current = empty();
      cursor.current = undefined;
      cursorExpired.current = false;
    }
    const publish = (patch: Partial<Snapshot>) => {
      current.current = { ...current.current, ...patch };
      if (current.current.error) retainedSnapshot.current = null;
      else if (current.current.complete) retainedSnapshot.current = current.current;
      // Rebuild independently; a partial replacement is not a new exact total.
      setSnapshot(
        retained && current.current.loadingMore && !current.current.error
          ? { ...retained, loadingMore: true, error: false }
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
    } finally {
      if (request.current === ac) {
        request.current = null;
        walking.current = false;
        settledAt.current = Date.now();
        if (!ac.signal.aborted) armRefresh.current();
      }
    }
  }, []);
  // A pending source refresh starts only when no walk is running, the tab is visible and the
  // cooldown since the last settled walk has elapsed; otherwise settle/visibility re-arms it.
  armRefresh.current = () => {
    if (!admitted.current || !refreshPending.current || walking.current || refreshTimer.current || tabHidden()) return;
    const wait = Math.max(0, settledAt.current + GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS - Date.now());
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      if (!refreshPending.current || walking.current || tabHidden()) return;
      refreshPending.current = false;
      void read(true);
    }, wait);
  };
  const restart = useCallback(() => {
    void read(true);
  }, [read]);
  const refetch = useCallback(() => {
    void read(!current.current.error || cursorExpired.current);
  }, [read]);
  /** Source-change entry point: never aborts a running walk, and coalesces bursts into one later walk. */
  const scheduleRefresh = useCallback(() => {
    if (!admitted.current) return;
    refreshPending.current = true;
    armRefresh.current();
  }, []);
  useEffect(() => {
    if (owner.current !== ownerKey || !enabled) {
      owner.current = ownerKey;
      current.current = empty();
      retainedSnapshot.current = null;
      cursor.current = undefined;
      setSnapshot(current.current);
    }
    admitted.current = active;
    if (active) {
      // A paused initial walk may have displayed results without reaching the last page.
      if (!retainedSnapshot.current && current.current.artifacts.length) retainedSnapshot.current = current.current;
      restart();
    }
    return () => {
      admitted.current = false;
      refreshPending.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      request.current?.abort();
      request.current = null;
      walking.current = false;
    };
  }, [active, enabled, ownerKey, restart]);
  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (!tabHidden()) armRefresh.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active]);
  const visible = enabled && owner.current === ownerKey ? snapshot : empty();
  return {
    ...visible,
    loading: active && visible.loading,
    loadingMore: active && visible.loadingMore,
    refetch,
    restart,
    scheduleRefresh,
  };
}
