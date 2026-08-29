'use client';

import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409) return '队列状态已更新，请按最新可用操作继续';
  return typeof error === 'string' ? error : 'Steer 失败，请重试';
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const addToast = useToastStore((state) => state.addToast);
  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);
  const [retryingAttemptIds, setRetryingAttemptIds] = useState<Set<string>>(() => new Set());

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`);
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (Array.isArray(data?.queue)) setQueue(threadId, data.queue);
  }, [setQueue, threadId]);

  const handleRetry = useCallback(
    async (messageId: string, targetCatId: string, attemptId: string) => {
      setRetryingAttemptIds((current) => new Set(current).add(attemptId));
      try {
        const response = await apiFetch(
          `/api/messages/${encodeURIComponent(messageId)}/queue-targets/${encodeURIComponent(targetCatId)}/retry`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attemptId }),
          },
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          addToast({
            type: 'error',
            title: '重试未成功',
            message: data?.error ?? '重试未能排入队列',
            threadId,
            duration: 5000,
          });
        }
      } catch {
        addToast({ type: 'error', title: '重试未成功', message: '重试请求没有完成', threadId, duration: 5000 });
      } finally {
        setRetryingAttemptIds((current) => {
          const next = new Set(current);
          next.delete(attemptId);
          return next;
        });
      }
    },
    [addToast, threadId],
  );

  const handleSteerConfirm = useCallback(async () => {
    if (!steerEntryId) return;
    try {
      const response = await apiFetch(`/api/threads/${threadId}/queue/${steerEntryId}/steer`, { method: 'POST' });
      if (response.ok) {
        setSteerEntryId(null);
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setSteerEntryId(null);
        await refreshQueue();
      }
      addToast({
        type: 'error',
        title: 'Steer 失败',
        message: steerFailureMessage(response.status, data?.code, data?.error),
        threadId,
        duration: 5000,
      });
    } catch {
      addToast({ type: 'error', title: 'Steer 失败', message: 'Steer 失败，请重试', threadId, duration: 5000 });
    }
  }, [addToast, refreshQueue, steerEntryId, threadId]);

  return {
    steerEntryId,
    retryingAttemptIds,
    handleRetry,
    handleSteerConfirm,
    handleSteerOpen: setSteerEntryId,
    handleSteerCancel: () => setSteerEntryId(null),
  };
}
