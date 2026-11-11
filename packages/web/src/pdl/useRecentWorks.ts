import type { GlobalArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorksSourceRefresh } from '@/hooks/useThreadArtifacts';
import type { ChatData } from './chat-models';
import { request } from './owner-api';
import { workKey } from './useReviewBindings';

/** The same project-scoped owner feeds the new-conversation page and workbench home. */
export function useRecentWorks(data: ChatData, needed: boolean | number = false) {
  const projectId =
    data.threadId === 'default'
      ? data.newProjectId
      : data.threads.find((thread) => thread.id === data.threadId)?.projectPath;
  const [attempt, retry] = useState(0);
  const sourceChanged = useCallback(() => retry((n) => n + 1), []);
  useWorksSourceRefresh(undefined, Boolean(needed), sourceChanged);
  const [read, setRead] = useState<{
    projectId: string;
    load: string;
    artifacts: (GlobalArtifactsResponse['artifacts'][number] & { navigationId: string })[];
  }>({ projectId: '', load: 'loading', artifacts: [] });
  useEffect(() => {
    if (!needed || !projectId) return;
    const abort = new AbortController();
    setRead((current) => (current.projectId === projectId ? current : { projectId, load: 'loading', artifacts: [] }));
    void request<GlobalArtifactsResponse & { complete: boolean }>(
      `/api/artifacts?view=recent-works&limit=3&projectId=${encodeURIComponent(projectId)}`,
      { signal: abort.signal },
    ).then(
      (result) => {
        if (!abort.signal.aborted)
          setRead({
            projectId,
            load: !result.complete ? 'error' : result.artifacts.length ? '' : 'empty',
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
