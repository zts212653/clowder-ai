import type { GlobalArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorksSourceRefresh } from '@/hooks/useThreadArtifacts';
import type { ChatData } from './chat-models';
import { request } from './owner-api';
import { workKey } from './useReviewBindings';

/** The same recent-works reader feeds the new-conversation page and workbench home. */
export function useRecentWorks(data: ChatData, needed: boolean | number = false) {
  const projectId =
    data.threadId === 'default'
      ? data.newProjectId || null
      : data.threads.find((thread) => thread.id === data.threadId)?.projectPath;
  const [attempt, retry] = useState(0);
  const sourceChanged = useCallback(() => retry((n) => n + 1), []);
  useWorksSourceRefresh(undefined, Boolean(needed), sourceChanged);
  const [read, setRead] = useState<{
    projectId: string | null;
    load: string;
    artifacts: (GlobalArtifactsResponse['artifacts'][number] & { navigationId: string })[];
  }>({ projectId: null, load: 'loading', artifacts: [] });
  useEffect(() => {
    if (!needed || projectId === undefined) return;
    const abort = new AbortController();
    setRead((current) => (current.projectId === projectId ? current : { projectId, load: 'loading', artifacts: [] }));
    void request<GlobalArtifactsResponse & { complete: boolean }>(
      `/api/artifacts?view=recent-works&limit=3${projectId === null ? '' : `&projectId=${encodeURIComponent(projectId)}`}`,
      { signal: abort.signal },
    ).then(
      (result) => {
        if (!abort.signal.aborted)
          setRead({
            projectId,
            // A bounded read that stopped early still shows what it found; only an empty one cannot claim "none".
            load: result.artifacts.length ? '' : result.complete ? 'empty' : 'error',
            artifacts: result.artifacts.map((work) => ({ ...work, navigationId: workKey(work) })),
          });
      },
      () => {
        if (!abort.signal.aborted) setRead({ projectId, load: 'error', artifacts: [] });
      },
    );
    return () => abort.abort();
  }, [needed, projectId, attempt]);
  const owners = useMemo(
    () => (read.projectId === projectId && read.load === '' ? read.artifacts : []),
    [read, projectId],
  );
  return {
    data: read,
    owners,
    action: async (name: string) => {
      if (name !== 'cafeRwRetry') return false;
      retry((n) => n + 1);
      return true;
    },
  };
}
