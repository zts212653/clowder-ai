import { projectThreadWorks, type ThreadArtifactDTO, type ThreadArtifactsResponse } from '@cat-cafe/shared';
import { apiFetch } from '../utils/api-client';
import { refreshMissingPrTitles } from './background-pr-titles';

const entries = new Map<string, ReturnType<typeof createEntry>>();
export function threadArtifactsEntry(key: string, threadId: string | undefined, view?: 'works') {
  const existing = entries.get(key);
  if (existing) return existing;
  const entry = createEntry(key, threadId, view);
  entries.set(key, entry);
  return entry;
}
function createEntry(key: string, threadId: string | undefined, view?: 'works') {
  const empty: ThreadArtifactDTO[] = [];
  let snapshot = {
    artifacts: empty,
    works: empty,
    loading: Boolean(threadId),
    error: false,
    total: null as number | null,
    complete: false,
  };
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let controller: AbortController | undefined;
  let scheduled = false;
  let dirty = false;
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const fetch = async () => {
    if (!threadId || !listeners.size) return;
    if (controller) {
      dirty = true;
      return;
    }
    const current = new AbortController();
    controller = current;
    publish({ ...snapshot, loading: true, error: false });
    try {
      const response = await apiFetch(
        `/api/threads/${encodeURIComponent(threadId)}/artifacts${view ? '?view=works' : ''}`,
        { signal: current.signal },
      );
      if (!response.ok) throw new Error(`artifacts fetch failed: ${response.status}`);
      const result: ThreadArtifactsResponse = await response.json();
      if (view && (result.view !== 'works' || !Array.isArray(result.artifacts)))
        throw new Error('Works view unavailable');
      if (current.signal.aborted) return;
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      const validTotal = Number.isSafeInteger(result.total) && (result.total ?? -1) >= 0;
      publish({
        artifacts,
        works: projectThreadWorks(artifacts, result.workLineage === 'resolved'),
        loading: false,
        error: false,
        total: validTotal ? (result.total ?? null) : view ? null : artifacts.length,
        complete: view ? result.complete === true && result.workLineage === 'resolved' && validTotal : true,
      });
      if (view)
        void refreshMissingPrTitles(artifacts, key, lifetime.signal).then((titles) => {
          if (lifetime.signal.aborted || !titles.size || snapshot.artifacts !== artifacts) return;
          const titled = artifacts.map((artifact) =>
            artifact.type === 'pr' && artifact.ref && titles.has(artifact.ref)
              ? { ...artifact, name: titles.get(artifact.ref)! }
              : artifact,
          );
          publish({
            ...snapshot,
            artifacts: titled,
            works: projectThreadWorks(titled, result.workLineage === 'resolved'),
          });
        });
    } catch {
      if (!current.signal.aborted)
        publish({ artifacts: empty, works: empty, loading: false, error: true, total: null, complete: false });
    } finally {
      controller = undefined;
      if (dirty && !current.signal.aborted) {
        dirty = false;
        refetch();
      }
    }
  };
  const refetch = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void fetch();
    });
  };
  const getSnapshot = () => snapshot;
  return {
    getSnapshot,
    refetch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1 && !controller && !scheduled) refetch();
      return () => {
        listeners.delete(listener);
        // StrictMode resubscribes in the same turn; one consumer leaving cannot cancel siblings.
        queueMicrotask(() => {
          if (listeners.size) return;
          controller?.abort();
          lifetime.abort();
          if (entries.get(key)?.getSnapshot === getSnapshot) entries.delete(key);
        });
      };
    },
  };
}
