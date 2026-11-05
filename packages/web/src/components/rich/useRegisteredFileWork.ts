'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { workspaceArtworkEntry } from '@/components/content-review/useChatArtworkEntry';
import { parsePublicationTarget } from '@/components/workbench/publication-surface';
import { API_URL, apiFetch } from '@/utils/api-client';

function publicationReference(url: string) {
  try {
    const base = new URL(API_URL);
    const value = new URL(url, base);
    if (value.origin !== base.origin && value.origin !== window.location.origin) return null;
    const match = /^\/api\/content-publications\/([^/]+)\/media\/(\d+)$/.exec(value.pathname);
    if (!match) return null;
    return parsePublicationTarget({ contentRef: decodeURIComponent(match[1] ?? ''), ownerRevision: Number(match[2]) });
  } catch {
    return null;
  }
}

/** A live workspace locator can name a retained version only after the owner checks its source revision. */
export function useRegisteredFileWork(url: string, threadId: string | undefined, enabled: boolean) {
  const locator = workspaceArtworkEntry(url);
  const publication = publicationReference(url);
  // The common WorkWorkspaceSource currently admits MP4; other formats keep their existing owner.
  const source: Record<string, string> | null = publication?.contentRef.startsWith('work:')
    ? { contentRef: publication.contentRef, ownerRevision: String(publication.ownerRevision) }
    : locator && /\.mp4$/i.test(locator.path)
      ? { worktreeId: locator.worktreeId, path: locator.path }
      : null;
  const key = threadId && source ? new URLSearchParams({ threadId, ...source }).toString() : '';
  const [loaded, setLoaded] = useState<{ key: string; artifact: ThreadArtifactDTO | null; error?: string }>();
  const resolve = useCallback(
    async (signal?: AbortSignal): Promise<ThreadArtifactDTO | null> => {
      if (!key) return null;
      const response = await apiFetch(`/api/works/resolve-file?${key}`, { signal });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '这份文件对应的作品版本需要核对，请从作品页选择。'
            : '暂时无法核对这份文件对应的原作品，请重试。',
        );
      const result = (await response.json()) as { artifact: ThreadArtifactDTO | null };
      return result.artifact;
    },
    [key],
  );
  useEffect(() => {
    if (!enabled || !key) return;
    const abort = new AbortController();
    void resolve(abort.signal)
      .then((artifact) => {
        if (!abort.signal.aborted) setLoaded({ key, artifact });
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({
            key,
            artifact: null,
            error: failure instanceof Error ? failure.message : '原作品暂时无法核对。',
          });
      });
    return () => abort.abort();
  }, [key, enabled, resolve]);
  return {
    resolve,
    reference: publication,
    artifact: loaded?.key === key ? loaded.artifact : null,
    loading: !!key && loaded?.key !== key,
    error: loaded?.key === key ? loaded.error : undefined,
  };
}
