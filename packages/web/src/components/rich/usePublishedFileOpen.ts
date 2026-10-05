import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

async function resolvePublication(url: string, threadId: string, sourceIds: readonly string[], signal: AbortSignal) {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts`, { signal });
  if (!response.ok) throw new Error('publication_unavailable');
  const body = (await response.json()) as { artifacts?: ThreadArtifactDTO[] };
  const matches = Array.isArray(body.artifacts)
    ? body.artifacts.filter(
        (artifact) =>
          artifact.type === 'file' && artifact.url === url && sourceIds.includes(artifact.sourceMessageId ?? ''),
      )
    : [];
  if (matches.length !== 1 || !matches[0]) throw new Error('publication_unresolved');
  return matches[0];
}

function sourceStillVisible(threadId: string, signal: AbortSignal): boolean {
  return !signal.aborted && useChatStore.getState().currentThreadId === threadId;
}

/** Resolve the original publication; opening never creates or edits an Artifact. */
export function usePublishedFileOpen(
  url: string,
  sourceThreadId?: string,
  messageId?: string,
  sourceMessageIds?: readonly string[],
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const sourceKey = (sourceMessageIds?.length ? sourceMessageIds : messageId ? [messageId] : []).join('\u0000');

  useEffect(() => {
    setError(false);
    setLoading(false);
    return () => {
      pending.current?.abort({ url, sourceThreadId, sourceKey });
      pending.current = null;
    };
  }, [url, sourceThreadId, sourceKey]);

  async function open() {
    if (!sourceThreadId || !sourceKey || pending.current) return;
    if (useChatStore.getState().currentThreadId !== sourceThreadId) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(false);
    try {
      const artifact = await resolvePublication(url, sourceThreadId, sourceKey.split('\u0000'), controller.signal);
      if (!sourceStillVisible(sourceThreadId, controller.signal)) return;
      useChatStore.getState().openPublishedArtifact(sourceThreadId, artifact);
    } catch {
      if (sourceStillVisible(sourceThreadId, controller.signal)) setError(true);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }

  return { open, loading, error };
}
