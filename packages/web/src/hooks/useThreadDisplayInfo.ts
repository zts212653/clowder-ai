'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { projectSidebarRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';

type ThreadDisplayInfo = {
  id: string;
  title: string | null;
  projectPath: string;
  preferredCats?: readonly string[];
  labels?: readonly string[];
  pinned?: boolean;
};
type ExactThread = ThreadDisplayInfo | { id: string; error: true };

function parseThreadDisplayInfo(value: unknown, threadId: string): ThreadDisplayInfo {
  if (!value || typeof value !== 'object') throw new Error('Invalid thread detail');
  const detail = value as Record<string, unknown>;
  if (
    detail.id !== threadId ||
    (detail.title !== null && typeof detail.title !== 'string') ||
    typeof detail.projectPath !== 'string'
  )
    throw new Error('Invalid thread detail');
  const preferredCats = Array.isArray(detail.preferredCats)
    ? detail.preferredCats.filter((id): id is string => typeof id === 'string')
    : [];
  const labels = Array.isArray(detail.labels)
    ? detail.labels.filter((label): label is string => typeof label === 'string')
    : [];
  return {
    id: threadId,
    title: detail.title as string | null,
    projectPath: detail.projectPath,
    preferredCats,
    labels,
    pinned: detail.pinned === true,
  };
}

/** Read the named conversation, including carriers omitted from the sidebar. Never use the global workspace path. */
export function useThreadDisplayInfo(threadId: string, fetchMissing = true) {
  const threads = useChatStore((state) => state.threads);
  const rows = useSidebarProjectionStore((state) => state.rows);
  const pendingThreadCommands = useSidebarProjectionStore((state) => state.pendingThreadCommands);
  const projectedRows = useMemo(
    () => projectSidebarRows({ rows, pendingThreadCommands }),
    [rows, pendingThreadCommands],
  );
  const listedThread =
    projectedRows.find((row) => row.id === threadId) ?? threads.find((thread) => thread.id === threadId);
  const [exactThread, setExactThread] = useState<ExactThread | null>(null);
  const currentThread: ThreadDisplayInfo | undefined =
    listedThread ?? (exactThread?.id === threadId && !('error' in exactThread) ? exactThread : undefined);
  const needsExactRead = fetchMissing && threadId !== 'default' && !listedThread;

  useEffect(() => {
    if (!needsExactRead) return;
    let current = true;
    void apiFetch(`/api/threads/${encodeURIComponent(threadId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Thread unavailable');
        const detail = parseThreadDisplayInfo(await response.json(), threadId);
        if (current) setExactThread(detail);
      })
      .catch(() => {
        if (current) setExactThread({ id: threadId, error: true });
      });
    return () => {
      current = false;
    };
  }, [needsExactRead, threadId]);

  return { currentThread, setExactThread, unavailable: exactThread?.id === threadId && 'error' in exactThread };
}
