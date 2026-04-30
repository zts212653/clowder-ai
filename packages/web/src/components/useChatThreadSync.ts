import { useCallback, useEffect, useRef } from 'react';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { assignDocumentRoute, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

interface UseChatThreadSyncParams {
  threadId: string;
  routePrefix?: string;
  messageCount: number;
  resetRefs: () => void;
}

export function useChatThreadSync({ threadId, routePrefix = '', messageCount, resetRefs }: UseChatThreadSyncParams) {
  const { clearTasks } = useTaskStore();
  const setCurrentThread = useChatStore((s) => s.setCurrentThread);
  const clearUnread = useChatStore((s) => s.clearUnread);
  const confirmUnreadAck = useChatStore((s) => s.confirmUnreadAck);
  const armUnreadSuppression = useChatStore((s) => s.armUnreadSuppression);
  const setCurrentProject = useChatStore((s) => s.setCurrentProject);
  const storeThreads = useChatStore((s) => s.threads);
  const prevThreadRef = useRef(threadId);

  const navigateToThread = useCallback(
    (tid: string) => {
      pushThreadRouteWithHistory(tid, typeof window !== 'undefined' ? window : undefined, routePrefix);
    },
    [routePrefix],
  );

  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      setCurrentThread(threadId);
      resetRefs();
      clearTasks();
      prevThreadRef.current = threadId;
    }
    setCurrentThread(threadId);
    reconnectGame(threadId).catch(() => {});
  }, [threadId, clearTasks, resetRefs, setCurrentThread]);

  useEffect(() => {
    const cached = storeThreads?.find((t) => t.id === threadId);
    if (cached) {
      setCurrentProject(cached.projectPath || 'default');
    }
  }, [threadId, storeThreads, setCurrentProject]);

  useEffect(() => {
    clearUnread(threadId);
  }, [threadId, clearUnread]);

  useEffect(() => {
    armUnreadSuppression(threadId);
    apiFetch(`/api/threads/${encodeURIComponent(threadId)}/read/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then((res) => {
        if (res.ok) {
          confirmUnreadAck(threadId);
        }
      })
      .catch((err) => {
        console.debug('[F069] read ack failed:', err);
      });
  }, [threadId, messageCount, confirmUnreadAck, armUnreadSuppression]);

  const handleSearchKnowledge = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    assignDocumentRoute(`/memory/search${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  }, [threadId]);

  const handleGoToMemoryHub = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    assignDocumentRoute(`/memory${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  }, [threadId]);

  return {
    navigateToThread,
    handleSearchKnowledge,
    handleGoToMemoryHub,
    storeThreads,
  };
}
