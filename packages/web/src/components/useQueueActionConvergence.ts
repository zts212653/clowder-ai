'use client';

/*
Architecture cell: dispatch
Queue actions consume per-target eligibility joined onto the authoritative source-entry Queue projection.
*/

import { useCallback, useState } from 'react';
import type { QueueActiveInvocationSlot } from '@/hooks/queue-active-invocation-hydration';
import { reconcileQueueActiveInvocationProjection } from '@/hooks/queue-active-invocation-reconciliation';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import type { SteerSubmission } from './SteerQueuedEntryModal';

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409) return '队列状态已更新，请按最新可用操作继续';
  return typeof error === 'string' ? error : 'Steer 失败，请重试';
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const addToast = useToastStore((state) => state.addToast);
  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`);
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (!Array.isArray(data?.queue)) return false;
    setQueue(threadId, data.queue);
    reconcileQueueActiveInvocationProjection({
      threadId,
      slots: data.activeInvocations as QueueActiveInvocationSlot[] | undefined,
      source: 'QueueActionRefresh',
    });
    return true;
  }, [setQueue, threadId]);

  const handleSteerConfirm = useCallback(
    async ({ sourceRecordId, observedPendingTargetIds, actions }: SteerSubmission) => {
      if (!steerEntryId || !sourceRecordId || actions.length === 0) return;
      try {
        const mappingResponse = await apiFetch(`/api/threads/${threadId}/queue/${steerEntryId}/targets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceRecordId,
            observedPendingTargetIds,
            targets: actions.map((action) => ({
              targetCatId: action.targetId,
              strategy: action.strategy,
              membershipAtOpen: action.membershipAtOpen,
            })),
          }),
        });
        const mapping = await mappingResponse.json().catch(() => ({}));
        if (!mappingResponse.ok || !Array.isArray(mapping?.targets)) {
          if (mappingResponse.status === 409) {
            setSteerEntryId(null);
            await refreshQueue();
          }
          addToast({
            type: 'error',
            title: 'Steer 失败',
            message: steerFailureMessage(mappingResponse.status, mapping?.code, mapping?.error),
            threadId,
            duration: 5000,
          });
          return;
        }

        const failures: string[] = [];
        for (const target of mapping.targets as Array<{
          entryId: string;
          targetCatId: string;
          strategy: 'guide_reply' | 'interrupt_reply';
        }>) {
          const route = target.strategy === 'guide_reply' ? 'continue' : 'steer';
          const response = await apiFetch(`/api/threads/${threadId}/queue/${target.entryId}/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCatId: target.targetCatId }),
          });
          if (response.ok) continue;
          const data = await response.json().catch(() => ({}));
          if (response.status === 404 || data?.code === 'ENTRY_PROCESSING' || data?.code === 'ENTRY_NOT_FOUND') {
            continue;
          }
          failures.push(`${target.targetCatId}: ${steerFailureMessage(response.status, data?.code, data?.error)}`);
        }
        setSteerEntryId(null);
        await refreshQueue();
        if (failures.length > 0) {
          addToast({
            type: 'error',
            title: '部分 Steer 未完成',
            message: failures.join('；'),
            threadId,
            duration: 5000,
          });
        }
      } catch {
        addToast({ type: 'error', title: 'Steer 失败', message: 'Steer 失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, refreshQueue, steerEntryId, threadId],
  );

  return {
    steerEntryId,
    handleSteerConfirm,
    handleSteerOpen: setSteerEntryId,
    handleSteerCancel: () => setSteerEntryId(null),
  };
}
