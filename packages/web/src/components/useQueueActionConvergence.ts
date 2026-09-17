'use client';

/*
Architecture cell: dispatch
Queue actions consume the existing per-target eligibility and authoritative Queue projection.
*/

import type { QueueRecoveryAction } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import type { QueueActiveInvocationSlot } from '@/hooks/queue-active-invocation-hydration';
import { reconcileQueueActiveInvocationProjection } from '@/hooks/queue-active-invocation-reconciliation';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

type ForceResetAction = Extract<QueueRecoveryAction, { kind: 'force_reset' }>;

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409) return '队列状态已更新，请按最新可用操作继续';
  return typeof error === 'string' ? error : 'Steer 失败，请重试';
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const setQueuePaused = useChatStore((state) => state.setQueuePaused);
  const addToast = useToastStore((state) => state.addToast);
  const [steerAction, setSteerAction] = useState<Extract<QueueRecoveryAction, { kind: 'steer' }> | null>(null);
  const [forceResetAction, setForceResetAction] = useState<ForceResetAction | null>(null);
  const [retryingAttemptIds, setRetryingAttemptIds] = useState<Set<string>>(() => new Set());
  const [resettingActionIds, setResettingActionIds] = useState<Set<string>>(() => new Set());

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`);
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (!Array.isArray(data?.queue)) return false;
    setQueue(threadId, data.queue);
    if (typeof data?.paused === 'boolean') setQueuePaused(threadId, data.paused, data.pauseReason);
    reconcileQueueActiveInvocationProjection({
      threadId,
      slots: data.activeInvocations as QueueActiveInvocationSlot[] | undefined,
      source: 'QueueActionRefresh',
    });
    return true;
  }, [setQueue, setQueuePaused, threadId]);

  const handleRetry = useCallback(
    async (action: Extract<QueueRecoveryAction, { kind: 'retry_target' }>) => {
      setRetryingAttemptIds((current) => new Set(current).add(action.id));
      try {
        const response = await apiFetch(action.request.path, {
          method: action.request.method,
          ...(action.request.body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(action.request.body) }
            : {}),
        });
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
          next.delete(action.id);
          return next;
        });
      }
    },
    [addToast, threadId],
  );

  const handleSteerConfirm = useCallback(async () => {
    if (!steerAction) return;
    try {
      const response = await apiFetch(steerAction.request.path, { method: steerAction.request.method });
      if (response.ok) {
        setSteerAction(null);
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setSteerAction(null);
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
  }, [addToast, refreshQueue, steerAction, threadId]);

  const handleForceResetConfirm = useCallback(async () => {
    if (!forceResetAction) return;
    const action = forceResetAction;
    setResettingActionIds((current) => new Set(current).add(action.id));
    try {
      const response = await apiFetch(action.request.path, { method: action.request.method });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        addToast({
          type: 'error',
          title: '恢复未成功',
          message: data?.error ?? '卡住的处理仍未解除',
          threadId,
          duration: 5000,
        });
        return;
      }
      await refreshQueue();
      addToast({ type: 'success', title: '已恢复', message: '卡住的处理已解除', threadId, duration: 3000 });
      setForceResetAction(null);
    } catch {
      addToast({ type: 'error', title: '恢复未成功', message: '恢复请求没有完成', threadId, duration: 5000 });
    } finally {
      setResettingActionIds((current) => {
        const next = new Set(current);
        next.delete(action.id);
        return next;
      });
    }
  }, [addToast, forceResetAction, refreshQueue, threadId]);

  return {
    steerEntryId: steerAction?.entryId ?? null,
    forceResetAction,
    retryingAttemptIds,
    resettingActionIds,
    handleRetry,
    refreshQueue,
    handleSteerConfirm,
    handleSteerOpen: setSteerAction,
    handleSteerCancel: () => setSteerAction(null),
    handleForceResetConfirm,
    handleForceResetOpen: setForceResetAction,
    handleForceResetCancel: () => setForceResetAction(null),
  };
}
