import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type Source = { id: string; title?: string | null; deleted: boolean };

/** Transient read of the existing thread owner. A hidden/missing record (404) cannot prove deletion. */
export function useCrossThreadLetterSource(sourceThreadId: string): Source {
  const listed = useChatStore((s) => s.threads.find((thread) => thread.id === sourceThreadId));
  const [read, setRead] = useState<Source>();
  const needsRead = !listed;
  useEffect(() => {
    if (!needsRead) return;
    const abort = new AbortController();
    void apiFetch(`/api/threads/${encodeURIComponent(sourceThreadId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Source unreadable');
        const detail: unknown = await response.json();
        if (!detail || typeof detail !== 'object') throw new Error('Invalid source');
        const record = detail as Record<string, unknown>;
        if (record.id !== sourceThreadId || (record.title !== null && typeof record.title !== 'string'))
          throw new Error('Invalid source');
        if (!abort.signal.aborted)
          setRead({
            id: sourceThreadId,
            title: record.title as string | null,
            deleted: typeof record.deletedAt === 'number',
          });
      })
      .catch(() => {
        if (!abort.signal.aborted) setRead({ id: sourceThreadId, deleted: false });
      });
    return () => abort.abort();
  }, [sourceThreadId, needsRead]);
  if (listed) return { id: listed.id, title: listed.title, deleted: typeof listed.deletedAt === 'number' };
  return read?.id === sourceThreadId ? read : { id: sourceThreadId, deleted: false };
}
