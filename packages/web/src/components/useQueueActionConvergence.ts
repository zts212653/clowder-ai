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
import { apiFetch, reportApiConnectionFailure } from '@/utils/api-client';
import { queuedGuidanceCopy } from './execution-row/queue-toast-copy';
import type { SteerSubmission } from './SteerQueuedEntryModal';

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409 && (code === 'CONTINUE_STATE_CHANGED' || code === 'STEER_ENTRY_UNAVAILABLE')) {
    return '队列状态已更新，请按最新可用操作继续';
  }
  return typeof error === 'string' ? error : '排队消息未能调整，请重试';
}

interface MappedSteerTarget {
  entryId: string;
  targetCatId: string;
  strategy: 'guide_reply' | 'interrupt_reply';
  status: number;
  result: { outcome?: string; code?: string; error?: string };
}

function collectSteerResults(targets: MappedSteerTarget[]) {
  const failures: string[] = [];
  const queuedTargets: Array<{ entryId: string; targetCatId: string }> = [];
  for (const target of targets) {
    const data = target.result;
    if (!data || typeof target.status !== 'number') {
      failures.push(`${target.targetCatId}: 未收到投递结果，请刷新查看队列状态`);
    } else if (target.status >= 200 && target.status < 300) {
      if (data.outcome === 'queued') queuedTargets.push(target);
    } else if (data.code !== 'ENTRY_PROCESSING' && data.code !== 'ENTRY_NOT_FOUND') {
      failures.push(`${target.targetCatId}: ${steerFailureMessage(target.status, data.code, data.error)}`);
    }
  }
  return { failures, queuedTargets };
}

function queuedGuidanceFeedback(
  threadId: string,
  targets: Array<{ entryId: string; targetCatId: string }>,
  refreshed: boolean,
): { title: string; message: string } | undefined {
  if (targets.length === 0 || !refreshed) return;
  const current = useChatStore.getState().getThreadState(threadId);
  const messages = targets.flatMap(({ entryId, targetCatId }) => {
    const entry = current.queue.find(
      (item) => item.id === entryId && item.status === 'queued' && item.targetCats.includes(targetCatId),
    );
    if (!entry) return [];
    const intent = entry.authorIntentByTarget?.[targetCatId];
    const invocation = current.catInvocations[targetCatId];
    const lifecycle =
      intent?.boundParentInvocationId === invocation?.invocationId ? invocation?.appServerLifecycle : undefined;
    return [queuedGuidanceCopy(intent?.effective, intent?.fallbackReason, lifecycle?.turnAccepted)];
  });
  if (messages.length === 0) return;
  return { title: '引导请求已保存', message: [...new Set(messages)].join('；') };
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const addToast = useToastStore((state) => state.addToast);
  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`).catch((error) => {
      reportApiConnectionFailure(error);
      return null;
    });
    if (!response?.ok) return false;
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
            title: '排队消息未能调整',
            message: steerFailureMessage(mappingResponse.status, mapping?.code, mapping?.error),
            threadId,
            duration: 5000,
          });
          return;
        }

        const { failures, queuedTargets } = collectSteerResults(mapping.targets);
        setSteerEntryId(null);
        const refreshed = await refreshQueue();
        if (failures.length > 0) {
          addToast({
            type: 'error',
            title: '部分成员还没接下这条消息',
            message: failures.join('；'),
            threadId,
            duration: 5000,
          });
        }
        const feedback = queuedGuidanceFeedback(threadId, queuedTargets, refreshed);
        if (feedback) addToast({ type: 'info', ...feedback, threadId, duration: 5000 });
      } catch (error) {
        if (reportApiConnectionFailure(error) || (error instanceof Error && error.name === 'AbortError')) return;
        addToast({
          type: 'error',
          title: '排队消息未能调整',
          message: '排队消息未能调整，请重试',
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, refreshQueue, steerEntryId, threadId],
  );

  return {
    refreshQueue,
    steerEntryId,
    handleSteerConfirm,
    handleSteerOpen: setSteerEntryId,
    handleSteerCancel: () => setSteerEntryId(null),
  };
}
