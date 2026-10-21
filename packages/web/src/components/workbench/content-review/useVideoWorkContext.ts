'use client';
import { type WorkContextRecord, workContextRecordSchema } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { checked, json } from '@/components/content-review/modification-http';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';

async function readVideoContext(contentRef: string, ownerRevision: number, threadId: string, signal: AbortSignal) {
  const value = await checked<unknown>(
    await apiFetch('/api/works/command', {
      ...json({ threadId, command: { action: 'read-context', reference: { contentRef, ownerRevision } } }),
      signal,
    }),
  );
  const record = value === null ? null : workContextRecordSchema.parse(value);
  if (record && (record.reference.contentRef !== contentRef || record.reference.ownerRevision !== ownerRevision))
    throw new Error('视频索引与这版成片不一致。');
  return record;
}

export function useVideoWorkContext(contentRef: string, ownerRevision: number) {
  const threadId = useChatStore((state) => state.currentThreadId);
  const visible = useWorkspaceSurfaceVisibility();
  const [state, setState] = useState<{ record: WorkContextRecord | null; loading: boolean; error: string | null }>({
    record: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    const abort = new AbortController();
    setState({ record: null, loading: true, error: null });
    if (!threadId || !visible) return () => abort.abort();
    const read = async () => {
      try {
        const record = await readVideoContext(contentRef, ownerRevision, threadId, abort.signal);
        if (!abort.signal.aborted) setState({ record, loading: false, error: null });
      } catch {
        if (!abort.signal.aborted)
          setState({ record: null, loading: false, error: '这版故事线和素材索引暂时无法读取。' });
      }
    };
    void read();
    const interval = setInterval(() => void read(), 5000);
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [contentRef, ownerRevision, threadId, visible]);
  return state;
}
